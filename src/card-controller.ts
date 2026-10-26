import { App, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, Plugin, setIcon } from "obsidian";
import { Choice, fieldLabels, genderFields, rerollLabels, Tables } from "./data";
import { currentGender, genderLabel, generate, generateAll, locateBlock, parseValues, pickForGender, readBlocks, Values } from "./core";
import { knownVariant } from "./variant-presence";
import { matchingVariants, VariantEditor, VariantLocation } from "./variant-editor";
import { CardTarget } from "./card-target";
import { DocumentController } from "./document-controller";
import { GenerationHistoryStore } from "./generation-history";
import { isHTMLElement, registerDocumentEvents } from "./window-events";
import { isCardLocked, lockedNotice } from "./card-lock";

type CardOptions = {
  app(): App;
  tables(): Tables;
  errors(): readonly string[];
  documents: DocumentController;
  history: GenerationHistoryStore;
  saveSettings(refresh?: boolean): Promise<void>;
  report(error: unknown): void;
};

export class CardController {
  readonly cards = new Map<HTMLElement, CardTarget>();
  private busyTargets = new Set<string>();
  private editingVariant = false;
  private highlightedBy = new WeakMap<HTMLElement, Set<HTMLElement>>();

  constructor(private options: CardOptions) {}

  register(plugin: Plugin): void {
    plugin.registerMarkdownCodeBlockProcessor("cloom", (source, el, ctx) => this.renderCard(source, el, ctx));
    registerDocumentEvents(plugin, (doc, listen) => {
      listen("copy", event => {
        const selection = doc.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed || !event.clipboardData) return;
        const content = createDiv();
        for (let index = 0; index < selection.rangeCount; index++) {
          content.append(selection.getRangeAt(index).cloneContents());
        }
        const buttons = content.querySelectorAll(".cloom-field-button, .cloom-section-button");
        if (!buttons.length) return;
        buttons.forEach(button => button.remove());
        event.clipboardData.setData("text/html", content.innerHTML);
        content.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
        content.querySelectorAll("h1, h2, h3, h4, h5, h6, p, div, section, header, li, blockquote, pre")
          .forEach(block => block.append("\n\n"));
        event.clipboardData.setData("text/plain", (content.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim());
        event.preventDefault();
        event.stopPropagation();
      }, true);
    });
  }

  moveTargets(oldPath: string, newPath: string): void {
    for (const target of this.cards.values()) {
      if (target.path === oldPath || target.path.startsWith(oldPath + "/")) target.path = newPath + target.path.slice(oldPath.length);
    }
  }

  refreshAll(): void {
    for (const path of new Set([...this.cards.values()].map(target => target.path))) this.refreshCards(path);
  }

  refreshCards(path: string): void {
    const editor = this.options.documents.editorFor(path);
    const blocks = editor ? readBlocks(editor.getValue()) : [];
    for (const [el, target] of this.cards) {
      if (target.path !== path) continue;
      const block = editor ? locateBlock(editor.getValue(), target.source, target.lineStart) ?? blocks.find(block => block.lineStart === target.lineStart) : undefined;
      if (editor && !block) continue;
      if (block) { target.source = block.source; target.lineStart = block.lineStart; }
      this.drawCard(el, target);
    }
  }

  private highlightUnknown(element: HTMLElement, target: CardTarget, key: string): void {
    if (isCardLocked(target.source)) return;
    const values = parseValues(target.source);
    const tableKey = key === "backstory-text" ? "backstory-title" : key;
    const present = !!values[tableKey]?.trim() || tableKey === "backstory-title" && !!values["backstory-text"]?.trim();
    if (present && !knownVariant(this.options.tables(), key, values)) element.addClass("cloom-draft-value");
    if (this.options.errors().length || element.closest(".markdown-reading-view, .markdown-preview-view")) return;
    if (!values[key]?.trim()) return;
    element.addClass("cloom-editable-value");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-haspopup", "dialog");
    element.setAttribute("title", "Редактировать");
    const story = element.closest<HTMLElement>(".cloom-story-content");
    if (story) this.highlightOnInteraction(element, [story]);
    const open = (event: Event) => {
      if (isHTMLElement(event.target) && event.target.closest("button")) return;
      event.stopPropagation();
      if (isCardLocked(target.source)) { new Notice(lockedNotice); return; }
      const locations = matchingVariants(this.options.tables(), tableKey, parseValues(target.source));
      if (!locations.length) { new Notice("Вариант не найден в таблицах. Изменение доступно в настройках Character Loom."); return; }
      const source = target.source;
      const snapshots = new Map(locations.map(location => [location.item, JSON.stringify(location.item)]));
      new VariantEditor(this.options.app(), this.options.tables(), tableKey, locations, (location, draft) =>
        this.commitVariant(target, source, tableKey, location, snapshots.get(location.item)!, draft), element).open();
    };
    element.addEventListener("click", open);
    element.addEventListener("keydown", event => { if (event.target === element && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(event); } });
  }

  private highlightOnInteraction(trigger: HTMLElement, targets: HTMLElement[]): void {
    let hovered = false;
    let focused = false;
    const update = () => {
      const active = !trigger.matches(":disabled") && (hovered || focused);
      for (const target of targets) {
        let sources = this.highlightedBy.get(target);
        if (!sources) { sources = new Set(); this.highlightedBy.set(target, sources); }
        if (active) sources.add(trigger);
        else sources.delete(trigger);
        if (sources.size) target.addClass("cloom-highlighted");
        else target.removeClass("cloom-highlighted");
      }
    };
    trigger.addEventListener("mouseenter", () => { hovered = true; update(); });
    trigger.addEventListener("mouseleave", () => { hovered = false; update(); });
    trigger.addEventListener("focus", () => { focused = trigger.matches(":focus-visible"); update(); });
    trigger.addEventListener("blur", () => { focused = false; update(); });
  }

  async commitVariant(target: CardTarget, source: string, key: string, location: VariantLocation, snapshot: string, draft?: Choice): Promise<void> {
    if (isCardLocked(target.source)) { new Notice(lockedNotice); throw new Error(lockedNotice); }
    if (this.options.errors().length) throw new Error("Character Loom: редактирование таблиц заблокировано до исправления data.json и перезапуска плагина.");
    const targetId = `${target.path}:${target.lineStart}`;
    if (this.editingVariant || this.busyTargets.has(targetId)) throw new Error("Дождитесь завершения текущего действия.");
    const { item, siblings, parent } = location;
    const index = siblings.indexOf(item);
    const values = parseValues(source);
    const cardGender = currentGender(this.options.tables(), values);
    if (target.source !== source || index < 0 || JSON.stringify(item) !== snapshot
      || !matchingVariants(this.options.tables(), key, values).some(found => found.item === item && found.siblings === siblings)) {
      throw new Error("Вариант или карточка изменились. Откройте форму заново.");
    }
    if (!draft && key === "gender") throw new Error("Пол нельзя удалить из карточки.");
    this.editingVariant = true;
    this.busyTargets.add(targetId);
    const original = structuredClone(item);
    const subtableName = parent?.subtableName;
    try {
      if (draft) {
        item.value = draft.value; item.weight = draft.weight;
        if (genderFields.includes(key)) item.gender = draft.gender;
        if (key === "backstory-title") item.pairedValue = draft.pairedValue;
      }
      else siblings.splice(index, 1);
      let updates: Values;
      if (draft) updates = key === "backstory-title"
        ? { "backstory-title": draft.value, "backstory-text": draft.pairedValue ?? "" }
        : { [key]: draft.value };
      else {
        updates = { [key]: "", ...(key === "backstory-title" ? { "backstory-text": "" } : {}),
          ...generate(this.options.tables(), key, values, Math.random, false) };
      }
      const variantGender = item.gender ?? parent?.gender;
      if (draft && genderFields.includes(key) && cardGender && variantGender && variantGender !== cardGender) {
        updates[key] = pickForGender(this.options.tables()[key] ?? [], cardGender)?.value ?? "";
      }
      if (!draft && parent && !siblings.length) { delete parent.children; delete parent.subtableName; }
      await this.options.saveSettings(false);
      if (target.source !== source) throw new Error("Карточка изменилась. Откройте форму заново.");
      if (!await this.options.documents.updateTarget(target, updates)) throw new Error("Блок изменился или не найден. Откройте форму заново.");
    } catch (error) {
      if (draft) {
        Object.assign(item, original);
        if (original.gender === undefined) delete item.gender;
        if (original.pairedValue === undefined) delete item.pairedValue;
      }
      else if (!siblings.includes(item)) siblings.splice(index, 0, item);
      if (parent && !parent.children) { parent.children = siblings; if (subtableName !== undefined) parent.subtableName = subtableName; }
      try { await this.options.saveSettings(false); } catch (rollbackError) { this.options.report(rollbackError); }
      throw error;
    } finally { this.editingVariant = false; this.busyTargets.delete(targetId); }
    for (const path of new Set([...this.cards.values()].map(card => card.path))) this.refreshCards(path);
  }

  async renderCard(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const section = ctx.getSectionInfo(el);
    const target: CardTarget = { path: ctx.sourcePath, source, lineStart: section?.lineStart, currentLine: () => ctx.getSectionInfo(el)?.lineStart };
    this.cards.set(el, target);
    if (ctx.addChild) {
      const child = new MarkdownRenderChild(el);
      child.onunload = () => {
        this.cards.delete(el);
        el.closest(".cm-embed-block")?.removeClass("cloom-embed-block");
      };
      ctx.addChild(child);
    }
    this.options.app().workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof MarkdownView && leaf.view.file?.path === target.path && !this.options.documents.validating.has(leaf.view.editor)) void this.options.documents.validateEditor(leaf.view).catch(error => this.options.report(error)); });
    const parsed = parseValues(source);
    const legacyGender = !parsed.gender && currentGender(this.options.tables(), parsed);
    if (!isCardLocked(source) && (!Object.keys(parsed).length || legacyGender)) {

      const updates = legacyGender
        ? { gender: genderLabel(this.options.tables(), legacyGender) ?? "" }
        : generateAll(this.options.tables(), {}, true);
      const id = `${target.path}:${target.lineStart}`;
      if (Object.keys(updates).length && !this.busyTargets.has(id)) {
        this.busyTargets.add(id);
        try {
          if (!await this.options.documents.updateTarget(target, updates, undefined)) new Notice("Character Loom: не удалось однозначно найти блок для генерации.");
        } catch (error) { this.options.report(error); }
        finally { this.busyTargets.delete(id); }
      }
    }
    this.drawCard(el, target);
  }

  drawCard(el: HTMLElement, target: CardTarget): void {
    this.cards.set(el, target);
    el.closest(".cm-embed-block")?.addClass("cloom-embed-block");
    el.empty();
    const raw = parseValues(target.source);
    const values: Values = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "gender" || this.options.tables()[key === "backstory-text" ? "backstory-title" : key]) values[key] = value;
    }
    const gender = currentGender(this.options.tables(), raw);
    if (!values.gender && gender) values.gender = genderLabel(this.options.tables(), gender) ?? "";
    const locked = isCardLocked(target.source);
    const card = el.createDiv({ cls: locked ? "cloom-card cloom-card-locked" : "cloom-card" });
    let busy = false;
    const appearanceKeys = ["gender-age", "height", "build", "hair-length", "hair-type", "eyes-kind", "eyes-form", "eyes-color", "appearance-feature", "clothing"];
    const reroll = async (key: string | string[] | undefined, excludeCurrent: boolean) => {
      if (isCardLocked(target.source)) { new Notice(lockedNotice); return; }
      const id = `${target.path}:${target.lineStart}`;
      if (busy || this.busyTargets.has(id)) return;
      busy = true;
      this.busyTargets.add(id);
      try {
        const generateUpdates = (): Values => {
          const current = parseValues(target.source);
          let result: Values;
          if (Array.isArray(key)) {
            result = {};
            for (const fieldKey of key) Object.assign(result, generate(this.options.tables(), fieldKey, { ...current, ...result }, Math.random, excludeCurrent));
          } else {
            const missing = key ? generateAll(this.options.tables(), current, true) : {};
            result = key
              ? { ...missing, ...generate(this.options.tables(), key, { ...current, ...missing }, Math.random, excludeCurrent) }
              : generateAll(this.options.tables(), current, false);
          }
          return excludeCurrent ? Object.fromEntries(Object.entries(result).filter(([field, value]) => current[field] !== value)) : result;
        };
        const updates = generateUpdates();
        if (!Object.keys(updates).length) { new Notice(excludeCurrent ? "Нет других подходящих вариантов для генерации." : "Нет вариантов для генерации."); return; }
        if (await this.options.documents.updateTarget(target, updates, "generate")) {
          this.refreshCards(target.path);
        }
        else new Notice("Character Loom: блок изменился или не найден. Переключите режим заметки и повторите.");
      } catch (error) { this.options.report(error); }
      finally { busy = false; this.busyTargets.delete(id); }
    };
    const rerollButton = (container: HTMLElement, key: string | string[] | undefined, label = Array.isArray(key) ? "Внешность" : key ? fieldLabels[key] : "всё", section = false, icon = section ? "refresh-cw" : "cloom-d20") => {
      const button = container.createEl("button", { cls: section ? "cloom-section-button" : "cloom-field-button", attr: { type: "button", "aria-label": rerollLabels[label], title: "" } });
      if (Array.isArray(key)) button.setAttribute("data-reroll-fields", key.join(" "));
      setIcon(button, icon);
      button.disabled = locked;
      if (!button.innerHTML) button.setText("d20");
      const excludeCurrent = !section || key === "quirk" || key === "backstory-title";
      button.addEventListener("click", event => { event.stopPropagation(); void reroll(key, excludeCurrent); });
    };
    const field = (container: HTMLElement, key: string, fallback = false, wholeValue = false): boolean => {
      if (!values[key] && !(fallback && this.options.tables()[key]?.length)) return false;
      const span = container.createSpan({ cls: "cloom-field" });
      const label = fieldLabels[key];
      const text = values[key] || `[${label}]`;
      if (wholeValue) {
        rerollButton(span, key);
        span.createSpan({ text });
      } else {
        const [, first, rest] = text.match(/^(\S+)([\s\S]*)$/) ?? ["", text, ""];
        const start = span.createSpan({ cls: "cloom-field-start" });
        rerollButton(start, key);
        start.createSpan({ text: first });
        span.createSpan({ text: rest });
      }
      this.highlightUnknown(span, target, key);
      const button = span.querySelector<HTMLElement>(".cloom-field-button");
      if (button) this.highlightOnInteraction(button, [span]);
      return true;
    };
    const section = (title: string, rerollKey: string | string[]) => {
      const box = card.createEl("section", { cls: "cloom-section" });
      const heading = box.createDiv({ cls: "cloom-section-heading" });
      heading.createEl("h3", { text: title });
      rerollButton(heading, rerollKey, title, true);
      return box.createDiv({ cls: "cloom-section-content" });
    };
    const has = (key: string) => !!values[key] || !!this.options.tables()[key]?.length;
    const identity = card.createEl("header", { cls: "cloom-identity" });
    const nameRow = identity.createDiv({ cls: "cloom-identity-heading" });
    const undo = nameRow.createEl("button", { cls: "cloom-section-button cloom-undo-button", attr: { type: "button", "aria-label": "Отменить генерацию", title: "Отменить генерацию" } });
    setIcon(undo, "undo-2");
    undo.disabled = locked || !this.options.history.forTarget(target)?.states.length;
    undo.addEventListener("click", event => {
      event.stopPropagation();
      if (isCardLocked(target.source)) { new Notice(lockedNotice); return; }
      if (busy || undo.disabled) return;
      busy = true;
      void (async () => {
        try {
          if (await this.options.documents.updateTarget(target, undefined, "undo")) { this.refreshCards(target.path); }
          else new Notice("Character Loom: блок изменился или не найден. Переключите режим заметки и повторите.");
        } catch (error) { this.options.report(error); }
        finally { busy = false; }
      })();
    });
    if (has("name") || has("surname")) {
      const fullName = nameRow.createEl("h2", { cls: "cloom-name" });
      if (has("name")) {
        this.highlightUnknown(fullName.createSpan({ cls: "cloom-given-name", text: values.name || "[Имя]" }), target, "name");
        fullName.appendText(" ");
      }
      const controls = fullName.createSpan({ cls: "cloom-name-controls" });
      if (has("name")) rerollButton(controls, ["name"], "Имя", false, "cloom-triangle-left");
      rerollButton(controls, ["name", "surname"].filter(has), "Имя и фамилия");
      if (has("surname")) rerollButton(controls, ["surname"], "Фамилия", false, "cloom-triangle-right");
      if (has("surname")) {
        this.highlightUnknown(fullName.createSpan({ cls: "cloom-surname", text: values.surname || "[Фамилия]" }), target, "surname");
      }
      controls.querySelectorAll<HTMLElement>("button[data-reroll-fields]").forEach(button => {
        const targets: HTMLElement[] = [];
        for (const key of (button.getAttribute("data-reroll-fields") ?? "").split(" ")) {
          const value = fullName.querySelector<HTMLElement>(key === "name" ? ".cloom-given-name" : ".cloom-surname");
          if (value) targets.push(value);
        }
        this.highlightOnInteraction(button, targets);
      });
    }
    const actions = nameRow.createDiv({ cls: "cloom-card-actions" });
    const lock = actions.createEl("button", { cls: "cloom-section-button cloom-lock-button", attr: {
      type: "button", "aria-label": locked ? "Разблокировать карточку" : "Заблокировать карточку",
      title: "", "aria-pressed": String(locked)
    } });
    setIcon(lock, locked ? "lock" : "lock-open");
    lock.addEventListener("mousedown", event => {
      if (event.button === 0) event.preventDefault();
      event.stopPropagation();
    });
    lock.addEventListener("click", event => {
      event.stopPropagation();
      const id = `${target.path}:${target.lineStart}`;
      if (busy || this.busyTargets.has(id)) return;
      const scrollPositions: Array<{ element: HTMLElement; top: number; left: number }> = [];
      for (let element = el.parentElement; element; element = element.parentElement) {
        scrollPositions.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      const restoreScroll = () => {
        for (const { element, top, left } of scrollPositions) {
          element.scrollTop = top;
          element.scrollLeft = left;
        }
      };
      busy = true;
      this.busyTargets.add(id);
      void (async () => {
        try {
          const previousSource = target.source;
          if (await this.options.documents.updateTarget(target, undefined, "toggle-lock")) {
            for (const other of this.cards.values()) {
              if (other.path === target.path && other.lineStart === target.lineStart && other.source === previousSource) other.source = target.source;
            }
            this.refreshCards(target.path);
            new Notice(isCardLocked(target.source) ? "Редактирование персонажа заблокировано" : "Разблокировано");
          } else new Notice("Character Loom: блок изменился или не найден. Переключите режим заметки и повторите.");
        } catch (error) { this.options.report(error); }
        finally {
          restoreScroll();
          el.ownerDocument.defaultView?.requestAnimationFrame(restoreScroll);
          busy = false;
          this.busyTargets.delete(id);
        }
      })();
    });
    rerollButton(actions, undefined, "всё", true);
    const metadata = ["gender", "race", "occupation", "mood"].filter(has);
    if (metadata.length) {
      const heading = identity.createEl("p", { cls: "cloom-meta" });
      metadata.forEach((key, index) => {
        if (index) heading.createSpan({ cls: "cloom-separator", text: " · " });
        field(heading, key, true, true);
      });
    }
    if (has("quirk")) this.highlightUnknown(section("Странность", "quirk").createEl("p", { text: values.quirk || "[Странность]" }), target, "quirk");
    const description = appearanceKeys.some(has) ? section("Внешность", appearanceKeys).createEl("p", { cls: "cloom-description" }) : undefined;
    if (description) {
      const suffix = (key: string, format: (value: string) => string) => {
        description.createSpan({ text: format(values[key] ?? "") });
      };
      if (has("gender-age")) { field(description, "gender-age", true); description.appendText(" "); }
      if (has("height")) {
        field(description, "height", true);
        suffix("height", value => /роста[.!]?$/i.test(value) ? "" : " роста");
      }
      if (has("build")) {
        description.appendText(" с "); field(description, "build", true);
        suffix("build", value => /фигурой[.!]?$/i.test(value) ? "" : " фигурой");
      }
      if (["gender-age", "height", "build"].some(has)) description.appendText(". ");
      const hair = ["hair-length", "hair-type"].filter(has);
      const eyes = ["eyes-kind", "eyes-form", "eyes-color"].filter(has);
      if (hair.length || eyes.length) {
        description.appendText("У персонажа ");
        for (const key of hair) { field(description, key, true); description.appendText(" "); }
        if (hair.length) description.appendText("волосы");
        if (hair.length && eyes.length) description.appendText(" и ");
        for (const key of eyes) { field(description, key, true); description.appendText(" "); }
        if (eyes.length) description.appendText("глаза");
        description.appendText(". ");
      }
      if (has("appearance-feature")) {
        field(description, "appearance-feature", true);
        suffix("appearance-feature", value => /[.!?…]$/.test(value) ? "" : ".");
        description.appendText(" ");
      }
      if (has("clothing")) field(description, "clothing", true);
    }
    if (values["backstory-title"] || values["backstory-text"] || this.options.tables()["backstory-title"]?.length) {
      const story = section("Предыстория", "backstory-title");
      story.addClass("cloom-story-content");
      this.highlightUnknown(story.createEl("p", { cls: "cloom-story-title", text: values["backstory-title"] || "[Название предыстории]" }), target, "backstory-title");
      if (values["backstory-text"] || values["backstory-title"] && !knownVariant(this.options.tables(), "backstory-title", raw)) this.highlightUnknown(story.createEl("p", { text: values["backstory-text"] || "[Текст предыстории]" }), target, "backstory-text");
    }
  }
}
