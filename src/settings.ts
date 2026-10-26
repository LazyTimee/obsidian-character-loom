import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type CharacterLoom from "./main";
import { Choice, fieldLabels, fieldOrder, genderFields } from "./data";
import { clearGender, genderChoices, setWeight } from "./core";
import { elementWindow } from "./window-events";
import { ListWindow, SETTINGS_PAGE_SIZE, VirtualSettingsList } from "./virtual-list";
import { exportTables, mergeTables, parseTableFile } from "./table-transfer";

type RowSpec = { item: Choice; key: string; siblings: Choice[]; parent?: Choice };
type Row = RowSpec & { el: HTMLElement; name: HTMLTextAreaElement; text?: HTMLTextAreaElement; percent: HTMLElement; select?: HTMLSelectElement };

export class CloomSettingTab extends PluginSettingTab {
  private openTables = new Set<string>();
  private ids = new WeakMap<Choice, string>();
  private nextId = 0;
  private drafts = new Set<Choice>();
  private rows: Row[] = [];
  private searchQuery = "";
  private content!: HTMLElement;
  private renderContainer?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private lists = new Set<VirtualSettingsList<RowSpec>>();
  private windows = new WeakMap<Choice[], ListWindow>();
  private searchWindow?: { query: string; states: Map<string, ListWindow> };
  private focusChoice?: Choice;
  private resizeFrame?: number;
  private resizeWindow?: Window;
  private pendingFields = new Set<HTMLTextAreaElement>();
  private lastWidth = 0;
  private busy = false;
  private transferStatus?: HTMLElement;
  private transferOpen = false;

  constructor(app: App, private plugin: CharacterLoom) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "Таблицы генератора персонажей",
      desc: "Редактирование вариантов и весов, импорт, экспорт и восстановление таблиц.",
      aliases: Object.values(fieldLabels),
      render: setting => {
        setting.settingEl.addClass("cloom-settings-host");
        this.renderSettings(setting.settingEl);
        return () => this.disposeView();
      }
    }];
  }

  // Fallback for Obsidian versions before 1.13.0.
  display(): void { this.renderSettings(this.containerEl); }

  private renderSettings(container: HTMLElement): void {
    this.renderContainer = container;
    this.resizeObserver?.disconnect();
    this.disposeLists();
    container.empty();
    this.containerEl.addClass("cloom-settings");
    new Setting(container).setName("Character Loom").setHeading().setClass("cloom-settings-title");
    container.createEl("p", { cls: "cloom-settings-description", text: "Здесь можно редактировать варианты для генерации персонажей. Таблицы общие для всех заметок текущего хранилища. Изменения сохраняются автоматически. Чтобы создать генератор в заметке, вызовите в палитре команд «Вставить генератор после текущего блока»." });
    this.renderTransferControls(container);
    if (this.plugin.settingsErrors.length) {
      container.createEl("p", { text: "В файле настроек генератора обнаружены ошибки. Сохранение таблиц заблокировано, исходный файл не изменён. Исправьте указанные записи вручную и перезапустите плагин или восстановите данные по умолчанию. Индексы записей начинаются с 0." });
      for (const error of this.plugin.settingsErrors) container.createEl("p", { text: error });
      return;
    }
    container.createEl("p", { cls: "cloom-settings-description", text: "Вес — целое число от 0, которое определяет частоту выпадения варианта. Например, веса 1, 1 и 2 дают шансы 25%, 25% и 50%. Вес 0 исключает вариант из генерации." });
    const search = container.createEl("input", { cls: "cloom-settings-search", type: "search", attr: { placeholder: "Поиск вариантов по значению", "aria-label": "Поиск вариантов" } });
    search.value = this.searchQuery;
    this.content = container.createDiv({ cls: "cloom-settings-content" });
    search.addEventListener("input", () => { this.searchQuery = search.value; this.renderContent(); });
    this.resizeObserver = new (elementWindow(this.containerEl).ResizeObserver)(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width !== this.lastWidth) { this.lastWidth = width; this.resizeFields(); }
    });
    this.resizeObserver.observe(this.containerEl);
    this.renderContent();
  }

  hide(): void {
    this.resizeObserver?.disconnect();
    if (this.busy || this.plugin.settingsErrors.length) { this.disposeLists(); return; }
    for (const row of this.rows) this.finishDraft(row);
    this.disposeLists();
    if (this.resizeFrame !== undefined) this.resizeWindow?.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.pendingFields.clear();
    void this.persist();
  }

  private disposeView(): void {
    this.resizeObserver?.disconnect();
    this.disposeLists();
    if (this.resizeFrame !== undefined) this.resizeWindow?.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.pendingFields.clear();
  }

  private choiceId(item: Choice): string {
    let id = this.ids.get(item);
    if (!id) { id = `choice-${++this.nextId}`; this.ids.set(item, id); }
    return id;
  }

  private label(key: string): string { return key === "gender-age" ? "Возраст" : key === "name" ? "Имена" : fieldLabels[key]; }

  private async persist(): Promise<void> {
    try { await this.plugin.saveSettings(); }
    catch (error) { console.error("Character Loom settings", error); new Notice("Не удалось сохранить настройки Character Loom."); }
  }

  private renderTransferControls(container: HTMLElement): void {
    const section = container.createEl("details", { cls: "cloom-table-transfer" });
    section.open = this.transferOpen;
    section.addEventListener("toggle", () => { this.transferOpen = section.open; });
    section.createEl("summary", { text: "Импорт и экспорт таблиц" });
    section.createEl("p", { cls: "cloom-settings-description", text: "Формат файла — JSON. Импорт добавляет новые значения и подтаблицы без дубликатов, сохраняя существующие значения и веса. При экспорте возраста, имён или фамилий включается таблица пола. Пол экспортируется отдельно, без зависимых таблиц." });
    const actions = section.createDiv({ cls: "cloom-transfer-actions" });
    const upload = actions.createEl("button", { text: "Импорт всех таблиц", attr: { type: "button" } });
    upload.disabled = this.plugin.settingsErrors.length > 0;
    upload.addEventListener("click", () => this.chooseImport());
    const download = actions.createEl("button", { text: "Экспорт всех таблиц", attr: { type: "button" } });
    download.disabled = this.plugin.settingsErrors.length > 0;
    download.addEventListener("click", () => { void this.downloadTables(); });
    this.transferStatus = section.createDiv({ cls: "cloom-transfer-status", attr: { role: "status", "aria-live": "polite" } });
    const reset = actions.createEl("button", { text: "Восстановить по умолчанию", cls: "cloom-restore-defaults", attr: { type: "button" } });
    reset.addEventListener("click", () => { void this.restoreDefaults(); });
  }

  private async restoreDefaults(): Promise<void> {
    if (this.busy || !await new RestoreDefaultsModal(this.app).openAndWait()) return;
    await this.transfer("Восстановление стандартных таблиц…", async () => {
      await this.plugin.restoreDefaultSettings();
      this.resetView();
      new Notice("Стандартные таблицы записаны в файл настроек генератора.");
    });
  }

  private async transfer(message: string, action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const status = this.transferStatus;
    status?.setText(message);
    this.containerEl.setAttribute("aria-busy", "true");
    this.containerEl.inert = true;
    try {
      // Let the status paint before parsing or merging a large file.
      await new Promise(resolve => elementWindow(this.containerEl).setTimeout(resolve, 30));
      await action();
    } catch (error) {
      console.error("Character Loom table transfer", error);
      new Notice(`Character Loom: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.busy = false;
      this.containerEl.inert = false;
      this.containerEl.removeAttribute("aria-busy");
      status?.setText("");
    }
  }

  private resetView(): void {
    this.rows = [];
    this.drafts.clear();
    this.windows = new WeakMap();
    this.searchWindow = undefined;
    this.renderSettings(this.renderContainer ?? this.containerEl);
  }

  private chooseImport(key?: string): void {
    if (this.busy) return;
    const input = this.containerEl.createEl("input", { type: "file", attr: { accept: ".json,application/json", hidden: "" } });
    input.addEventListener("cancel", () => input.remove());
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      void this.transfer("Проверка и импорт таблиц…", async () => {
        const incoming = parseTableFile(await file.text());
        const result = mergeTables(this.plugin.settings.tables, incoming, key);
        await this.plugin.importTables(result.tables);
        this.resetView();
        new Notice(`Импорт завершён. Добавлено вариантов: ${result.added}.`);
      });
    });
    input.click();
  }

  private async downloadTables(key?: string): Promise<void> {
    await this.transfer("Подготовка файла таблиц…", async () => {
      const content = JSON.stringify(exportTables(this.plugin.settings.tables, key), null, 2);
      const win = elementWindow(this.containerEl);
      const url = win.URL.createObjectURL(new win.Blob([content], { type: "application/json" }));
      const link = this.containerEl.createEl("a", { attr: { href: url, download: key ? `cloom-${key}.json` : "cloom-tables.json", hidden: "" } });
      try { link.click(); }
      finally { link.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 60000); }
    });
  }

  private renderContent(focus?: Choice): void {
    for (const row of this.rows) {
      if (row.item !== focus && this.containerEl.ownerDocument.activeElement !== row.name && this.containerEl.ownerDocument.activeElement !== row.text) this.finishDraft(row);
    }
    const scroll = this.containerEl.scrollTop;
    this.disposeLists();
    this.rows = [];
    this.content.empty();
    this.focusChoice = focus;
    const query = this.searchQuery.trim().toLocaleLowerCase("ru-RU");
    if (query) {
      const results = this.content.createDiv({ cls: "cloom-search-results" });
      const matches: RowSpec[] = [];
      const visit = (key: string, items: Choice[], parent?: Choice) => {
        for (const item of items) {
          if (item.value.toLocaleLowerCase("ru-RU").includes(query) || this.drafts.has(item)) matches.push({ key, item, siblings: items, parent });
          if (item.children) visit(key, item.children, item);
        }
      };
      for (const [key, items] of Object.entries(this.plugin.settings.tables)) visit(key, items);
      const relevance = (match: RowSpec): number => {
        const value = match.item.value.toLocaleLowerCase("ru-RU");
        return value === query ? 0 : value.startsWith(query) ? 1 : value.includes(query) ? 2 : 3;
      };
      matches.sort((a, b) => relevance(a) - relevance(b));
      if (!matches.length) results.createEl("p", { text: "Варианты не найдены." });
      else {
        if (this.searchWindow?.query !== query) this.searchWindow = { query, states: new Map() };
        const groups = new Map<string, RowSpec[]>();
        for (const match of matches) {
          let groupMatches = groups.get(match.key);
          if (!groupMatches) { groupMatches = []; groups.set(match.key, groupMatches); }
          groupMatches.push(match);
        }
        for (const [key, tableMatches] of groups) {
          const group = results.createDiv({ cls: "cloom-search-group" });
          new Setting(group).setName(`${this.label(key)} (${tableMatches.length})`).setHeading();
          let state = this.searchWindow.states.get(key);
          if (!state) { state = this.newWindow(); this.searchWindow.states.set(key, state); }
          this.renderVirtualList(group.createDiv({ cls: "cloom-virtual-list" }), tableMatches, state);
        }
      }
    } else {
      for (const key of ["gender", "gender-age", "name", ...fieldOrder.filter(key => key !== "name" && key !== "gender-age")]) this.renderTable(this.content, key);
    }
    this.refreshGenders();
    this.refreshProbabilities();
    this.resizeFields();
    this.containerEl.scrollTop = scroll;
    if (focus) {
      const row = this.rows.find(row => row.item === focus);
      row?.name.focus({ preventScroll: true });
      row?.name.scrollIntoView({ block: "nearest" });
    }
    this.focusChoice = undefined;
  }

  private resizeFields(fields = this.rows.flatMap(row => row.text ? [row.name, row.text] : [row.name])): void {
    for (const field of fields) this.pendingFields.add(field);
    if (this.resizeFrame !== undefined) return;
    this.resizeWindow = elementWindow(this.containerEl);
    this.resizeFrame = this.resizeWindow.requestAnimationFrame(() => {
      this.resizeFrame = undefined;
      const visible = [...this.pendingFields].filter(field => field.isConnected && field.getClientRects().length);
      this.pendingFields.clear();
      for (const field of visible) field.setCssStyles({ height: "auto" });
      const heights = visible.map(field => field.scrollHeight + 2);
      visible.forEach((field, index) => field.setCssStyles({ height: `${heights[index]}px` }));
    });
  }

  private disposeLists(): void {
    for (const list of [...this.lists]) list.dispose();
    this.lists.clear();
  }

  private releaseRows(container: HTMLElement): void {
    for (const list of [...this.lists]) if (container.contains(list.container)) { list.dispose(); this.lists.delete(list); }
    this.rows = this.rows.filter(row => {
      if (!container.contains(row.el)) return true;
      this.pendingFields.delete(row.name);
      if (row.text) this.pendingFields.delete(row.text);
      return false;
    });
  }

  private newWindow(): ListWindow { return { loaded: SETTINGS_PAGE_SIZE, heights: [], mounted: new Set([0]) }; }

  private renderVirtualList(container: HTMLElement, specs: RowSpec[], state: ListWindow): void {
    const list = new VirtualSettingsList({
      root: this.containerEl, container, items: specs, state,
      focusIndex: this.focusChoice ? specs.findIndex(spec => spec.item === this.focusChoice) : undefined,
      render: (target, spec) => this.renderChoice(target, spec.key, spec.item, spec.siblings, spec.parent),
      release: target => this.releaseRows(target),
      updated: () => { this.refreshGenders(); this.refreshProbabilities(); this.resizeFields(); }
    });
    this.lists.add(list);
  }

  private renderTable(container: HTMLElement, key: string): void {
    const items = this.plugin.settings.tables[key] ?? [];
    const details = container.createEl("details", { cls: "cloom-settings-table" });
    details.open = this.openTables.has(key);
    const summary = details.createEl("summary", { text: `${this.label(key)} (${items.length})` });
    const actions = summary.createSpan({ cls: "cloom-table-actions" });
    actions.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
    this.createIconButton(actions, "download", `Импорт: ${this.label(key)}`, () => this.chooseImport(key));
    this.createIconButton(actions, "upload", `Экспорт: ${this.label(key)}`, () => this.downloadTables(key));
    let body: HTMLElement | undefined;
    const populate = () => {
      if (body) return;
      body = details.createDiv({ cls: "cloom-table-body" });
      if (this.hasGender(key)) {
        body.createEl("p", { cls: "cloom-settings-description", text: "Пол ограничивает применение варианта. «Любой» подходит для всех полов." });
        body.createEl("p", { cls: "cloom-settings-description", text: "Для варианта с указанным полом процент рассчитан среди вариантов этого пола и «Любой». Для «Любой» — среди всех вариантов списка." });
      }
      const labels = body.createDiv({ cls: `cloom-choice-head${this.hasGender(key) ? " cloom-has-gender" : ""}` });
      for (const text of this.hasGender(key) ? ["Вес / шанс", "Значение", "Пол", ""] : ["Вес / шанс", key === "backstory-title" ? "Название" : "Значение", ""]) labels.createSpan({ text });
      this.renderList(body, key, items);
      this.refreshGenders();
      this.refreshProbabilities();
      this.resizeFields();
    };
    details.addEventListener("toggle", () => {
      if (details.open) { this.openTables.add(key); populate(); this.resizeFields(); }
      else {
        this.openTables.delete(key);
        if (body) { this.releaseRows(body); body.remove(); body = undefined; }
      }
    });
    if (details.open) populate();
  }

  private hasGender(key: string): boolean { return genderFields.includes(key); }

  private renderList(container: HTMLElement, key: string, items: Choice[], parent?: Choice): void {
    if (!items.length) {
      const button = container.createEl("button", { text: "Добавить вариант", cls: "cloom-add-empty" });
      button.addEventListener("click", () => this.add(key, items, -1));
    }
    if (items.length) {
      let state = this.windows.get(items);
      if (!state) { state = this.newWindow(); this.windows.set(items, state); }
      this.renderVirtualList(container.createDiv({ cls: "cloom-virtual-list" }), items.map(item => ({ key, item, siblings: items, parent })), state);
    }
  }

  private add(key: string, items: Choice[], index: number): void {
    const entry: Choice = { value: "", weight: 1, ...(key === "gender" ? { gender: crypto.randomUUID() } : this.hasGender(key) ? { gender: "" } : {}), ...(key === "backstory-title" ? { pairedValue: "" } : {}) };
    items.splice(index + 1, 0, entry);
    this.drafts.add(entry);
    this.renderContent(entry);
  }

  private createIconButton(container: HTMLElement, name: string, label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = container.createEl("button", { cls: "cloom-setting-icon", attr: { type: "button", "aria-label": label, "data-tooltip-position": "top" } });
    setIcon(button, name);
    button.addEventListener("click", () => { void action(); });
    return button;
  }

  private refreshProbabilities(): void {
    const sums = new Map<Choice[], { scale: number; total: number; any: number; genders: Map<string, number> }>();
    for (const row of this.rows) {
      let sum = sums.get(row.siblings);
      if (!sum) {
        const scale = row.siblings.reduce((largest, entry) => Math.max(largest, entry.weight), 0);
        sum = { scale, total: 0, any: 0, genders: new Map() };
        for (const entry of row.siblings) {
          const weight = scale ? entry.weight / scale : 0;
          const gender = entry.gender ?? row.parent?.gender;
          sum.total += weight;
          if (gender) sum.genders.set(gender, (sum.genders.get(gender) ?? 0) + weight);
          else sum.any += weight;
        }
        sums.set(row.siblings, sum);
      }
      const gender = row.item.gender ?? row.parent?.gender;
      const total = this.hasGender(row.key) && gender ? sum.any + (sum.genders.get(gender) ?? 0) : sum.total;
      const chance = total && sum.scale ? (row.item.weight / sum.scale) / total * 100 : 0;
      row.percent.setText(`≈ ${chance.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`);
    }
  }

  private refreshGenders(): void {
    const genders = genderChoices(this.plugin.settings.tables);
    for (const row of this.rows) {
      const select = row.select;
      if (!select) continue;
      select.empty();
      select.createEl("option", { value: "", text: "Любой" });
      for (const item of genders) if (item.gender) select.createEl("option", { value: item.gender, text: item.value });
      select.value = row.item.gender ?? row.parent?.gender ?? "";
    }
  }

  private finishDraft(row: Row): boolean {
    if (!this.drafts.has(row.item)) return false;
    if (row.item.value.trim() || row.item.pairedValue?.trim()) { this.drafts.delete(row.item); return false; }
    const index = row.siblings.indexOf(row.item);
    if (index < 0) return false;
    row.siblings.splice(index, 1);
    this.drafts.delete(row.item);
    if (row.parent && !row.siblings.length) { delete row.parent.children; delete row.parent.subtableName; this.openTables.delete(this.choiceId(row.parent)); }
    return true;
  }

  private renderChoice(container: HTMLElement, key: string, item: Choice, siblings: Choice[], parent?: Choice): void {
    const el = container.createDiv({ cls: "cloom-setting-choice" });
    const line = el.createDiv({ cls: `cloom-choice-row${this.hasGender(key) ? " cloom-has-gender" : ""}` });
    const weights = line.createDiv({ cls: "cloom-choice-weight" });
    const weight = weights.createEl("input", { type: "number", value: String(item.weight), attr: { min: "0", max: String(Number.MAX_SAFE_INTEGER), step: "1", "aria-label": "Целый вес варианта" } });
    const percent = weights.createSpan({ cls: "cloom-choice-percent" });
    const name = line.createEl("textarea", { cls: "cloom-value-input", attr: { rows: "1", "aria-label": fieldLabels[key], placeholder: key === "backstory-title" ? "Название предыстории" : "Новый вариант" } });
    name.value = item.value;
    const row: Row = { item, key, siblings, parent, el, name, percent };
    this.rows.push(row);
    name.addEventListener("input", () => { item.value = name.value.replace(/[\r\n]+/g, " "); this.resizeFields([name]); if (key === "gender") this.refreshGenders(); });
    name.addEventListener("change", () => { item.value = name.value.trim().replace(/[\r\n]+/g, " "); void this.persist(); });
    weight.addEventListener("change", () => {
      const value = Number(weight.value);
      if (!weight.value.trim() || !Number.isSafeInteger(value) || value < 0) { weight.value = String(item.weight); new Notice("Введите целое неотрицательное число."); return; }
      setWeight(siblings, item, value); this.refreshProbabilities(); void this.persist();
    });
    if (this.hasGender(key)) {
      const select = line.createEl("select", { cls: "cloom-gender-select", attr: { "aria-label": "Пол варианта" } });
      row.select = select;
      select.addEventListener("change", () => { item.gender = select.value; this.refreshProbabilities(); void this.persist(); });
    }
    const controls = line.createDiv({ cls: "cloom-choice-actions" });
    this.createIconButton(controls, "plus", "Добавить вариант ниже", () => this.add(key, siblings, siblings.indexOf(item)));
    if (!parent) {
      const toggle = this.createIconButton(controls, "table-2", item.children ? `${this.openTables.has(this.choiceId(item)) ? "Свернуть" : "Раскрыть"} подтаблицу` : "Создать подтаблицу", async () => {
        const id = this.choiceId(item);
        if (item.children && this.openTables.has(id)) {
          this.openTables.delete(id);
          if (!item.children.length) { delete item.children; delete item.subtableName; }
          this.renderContent(); await this.persist();
        } else {
          item.children ??= [];
          this.openTables.add(id);
          if (!item.children.length) this.add(key, item.children, -1);
          else this.renderContent();
        }
      });
      toggle.addClass("cloom-subtable-toggle");
      toggle.setAttribute("aria-expanded", String(this.openTables.has(this.choiceId(item))));
      toggle.createSpan({ cls: "cloom-subtable-count", text: item.children ? String(item.children.length) : "+" });
    } else controls.createSpan({ cls: "cloom-subtable-placeholder" });
    this.createIconButton(controls, "trash-2", "Удалить вариант", async () => {
      if (key === "gender" && item.value.trim() && !await new DeleteGenderModal(this.app, item.value).openAndWait()) return;
      if (key === "gender") for (const gender of [item, ...(item.children ?? [])]) if (gender.gender) clearGender(this.plugin.settings.tables, gender.gender);
      const index = siblings.indexOf(item);
      if (index >= 0) siblings.splice(index, 1);
      if (parent && !siblings.length) {
        delete parent.children;
        delete parent.subtableName;
        this.openTables.delete(this.choiceId(parent));
      }
      this.drafts.delete(item);
      this.renderContent(); await this.persist();
    });
    if (key === "backstory-title") {
      const label = el.createEl("label", { cls: "cloom-story-label", text: "Текст предыстории", attr: { for: `cloom-story-${this.choiceId(item)}` } });
      row.text = el.createEl("textarea", { cls: "cloom-value-input cloom-story-input", attr: { id: label.htmlFor, rows: "4", "aria-label": "Текст предыстории", placeholder: "Текст предыстории" } });
      row.text.value = item.pairedValue ?? "";
      row.text.addEventListener("input", () => { item.pairedValue = row.text!.value.replace(/[\r\n]+/g, " "); this.resizeFields([row.text!]); });
      row.text.addEventListener("change", () => { void this.persist(); });
    }
    el.addEventListener("focusout", () => {
      elementWindow(el).setTimeout(() => {
        if (!el.isConnected || el.contains(this.containerEl.ownerDocument.activeElement)) return;
        const active = this.rows.find(row => row.el.contains(this.containerEl.ownerDocument.activeElement));
        if (this.finishDraft(row)) { this.renderContent(active?.item); void this.persist(); }
      }, 0);
    });
    if (item.children && !parent && this.openTables.has(this.choiceId(item))) {
      const body = el.createDiv({ cls: "cloom-subtable-body" });
      body.createEl("p", { cls: "cloom-settings-description", text: "При выборе этой строки результат берётся из её подтаблицы. Веса внутри подтаблицы определяют частоту её вариантов. Показанные проценты относятся к выбору внутри подтаблицы." });
      this.renderList(body, key, item.children, item);
    }
  }
}

class RestoreDefaultsModal extends Modal {
  private resolve!: (confirmed: boolean) => void;
  private confirmed = false;
  openAndWait(): Promise<boolean> {
    const result = new Promise<boolean>(resolve => this.resolve = resolve);
    this.open(); return result;
  }
  onOpen(): void {
    this.titleEl.setText("Восстановить стандартные таблицы?");
    this.contentEl.createEl("p", { text: "Все пользовательские значения и подтаблицы будут удалены и заменены стандартными данными, как при первом запуске плагина. Файл настроек генератора будет перезаписан. Это действие нельзя отменить. Перед восстановлением можно экспортировать таблицы." });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("Восстановить").setClass("mod-warning").onClick(() => { this.confirmed = true; this.close(); }))
      .addButton(button => button.setButtonText("Отмена").onClick(() => this.close()));
  }
  onClose(): void { this.resolve(this.confirmed); this.contentEl.empty(); }
}

class DeleteGenderModal extends Modal {
  private resolve!: (confirmed: boolean) => void;
  private confirmed = false;
  constructor(app: App, private value: string) { super(app); }
  openAndWait(): Promise<boolean> {
    const result = new Promise<boolean>(resolve => this.resolve = resolve);
    this.open(); return result;
  }
  onOpen(): void {
    this.titleEl.setText(`Удалить пол «${this.value}»?`);
    this.contentEl.createEl("p", { text: "У связанных вариантов возраста и имён пол изменится на «Любой»." });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("Удалить").setClass("mod-warning").onClick(() => { this.confirmed = true; this.close(); }))
      .addButton(button => button.setButtonText("Отмена").onClick(() => this.close()));
  }
  onClose(): void { this.resolve(this.confirmed); this.contentEl.empty(); }
}
