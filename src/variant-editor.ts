import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { Choice, fieldLabels, genderFields, Tables } from "./data";
import { elementWindow } from "./window-events";
import { genderChoices, Values } from "./core";

export type VariantLocation = { item: Choice; siblings: Choice[]; parent?: Choice };
const clean = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
export function matchingVariants(tables: Tables, key: string, values: Values): VariantLocation[] {
  const matches: VariantLocation[] = [];
  const visit = (siblings: Choice[], parent?: Choice) => {
    for (const item of siblings) {
      if (!item.children && clean(item.value) === clean(values[key] ?? "")
        && (key !== "backstory-title" || clean(item.pairedValue ?? "") === clean(values["backstory-text"] ?? ""))) matches.push({ item, siblings, parent });
      if (item.children) visit(item.children, item);
    }
  };
  visit(tables[key] ?? []);
  return matches;
}

export class VariantEditor extends Modal {
  private resizeFrame?: number;
  private resizeWindow?: Window;
  private stopPositioning?: () => void;
  private stopDeleteReset?: () => void;
  constructor(app: App, private tables: Tables, private key: string, private locations: VariantLocation[],
    private commit: (location: VariantLocation, draft?: Choice) => Promise<void>, private anchor?: HTMLElement) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("cloom-variant-modal");
    this.contentEl.addClass("cloom-settings", "cloom-variant-editor");
    this.render(this.contentEl.createDiv(), this.locations[0]);
    if (this.anchor) this.positionAtAnchor(this.anchor);
  }

  private positionAtAnchor(anchor: HTMLElement): void {
    const win = elementWindow(anchor);
    if (!win) return;
    this.modalEl.addClass("cloom-anchored-modal");
    const place = () => {
      if (!anchor.isConnected) { this.close(); return; }
      const margin = 12;
      const gap = 8;
      const viewport = win.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? win.innerWidth;
      const height = viewport?.height ?? win.innerHeight;
      const rect = anchor.getBoundingClientRect();
      this.modalEl.setCssStyles({ width: `${Math.min(760, Math.max(0, width - margin * 2))}px` });
      const modalWidth = this.modalEl.getBoundingClientRect().width;
      this.modalEl.setCssStyles({ left: `${Math.max(leftEdge + margin, Math.min(rect.left, leftEdge + width - modalWidth - margin))}px` });
      const below = Math.max(0, topEdge + height - margin - rect.bottom - gap);
      const above = Math.max(0, rect.top - gap - topEdge - margin);
      // Prefer below; use the space above only when the bottom edge leaves too little room.
      const useAbove = below < 160 && above > below;
      const available = useAbove ? above : below;
      this.modalEl.setCssStyles({ maxHeight: `${available}px` });
      const modalHeight = this.modalEl.getBoundingClientRect().height;
      this.modalEl.setCssStyles({ top: `${useAbove ? Math.max(topEdge + margin, rect.top - gap - modalHeight) : rect.bottom + gap}px` });
    };
    const observer = new win.ResizeObserver(place);
    observer.observe(this.modalEl);
    observer.observe(anchor);
    win.addEventListener("resize", place);
    win.addEventListener("scroll", place, true);
    win.visualViewport?.addEventListener("resize", place);
    win.visualViewport?.addEventListener("scroll", place);
    this.stopPositioning = () => {
      observer.disconnect();
      win.removeEventListener("resize", place);
      win.removeEventListener("scroll", place, true);
      win.visualViewport?.removeEventListener("resize", place);
      win.visualViewport?.removeEventListener("scroll", place);
    };
    place();
  }

  private tablePath(location: VariantLocation): string[] {
    return [this.key === "name" ? "Имена" : fieldLabels[this.key],
      ...(location.parent ? [location.parent.subtableName || location.parent.value] : [])];
  }

  private render(body: HTMLElement, location: VariantLocation): void {
    body.empty();
    const heading = new Setting(body).setHeading().nameEl;
    [...this.tablePath(location), location.item.value].forEach((part, index) => {
      if (index) heading.createSpan({ cls: "cloom-breadcrumb-separator", text: " ▸ ", attr: { "aria-hidden": "true" } });
      heading.createSpan({ text: part });
    });
    const draft = structuredClone(location.item);
    const hasGender = genderFields.includes(this.key);
    const editableState = (item: Choice) => JSON.stringify([
      clean(item.value), item.weight,
      hasGender ? item.gender ?? location.parent?.gender ?? "" : "",
      this.key === "backstory-title" ? clean(item.pairedValue ?? "") : ""
    ]);
    const originalState = editableState(draft);
    const cls = hasGender ? " cloom-has-gender" : "";
    const head = body.createDiv({ cls: `cloom-choice-head${cls}` });
    for (const label of ["Вес / шанс", this.key === "backstory-title" ? "Название" : "Значение", ...(hasGender ? ["Пол"] : []), ""]) head.createSpan({ text: label });
    const row = body.createDiv({ cls: `cloom-choice-row${cls}` });
    const weights = row.createDiv({ cls: "cloom-choice-weight" });
    const weight = weights.createEl("input", { type: "number", value: String(draft.weight), attr: { min: "0", step: "1", "aria-label": "Целый вес варианта" } });
    const percent = weights.createSpan({ cls: "cloom-choice-percent" });
    const name = row.createEl("textarea", { cls: "cloom-value-input", attr: { rows: "1", "aria-label": "Значение варианта" } });
    name.value = draft.value;
    const resize = (field: HTMLTextAreaElement) => { field.setCssStyles({ height: "auto" }); field.setCssStyles({ height: `${field.scrollHeight + 2}px` }); };
    const probability = () => {
      const gender = draft.gender ?? location.parent?.gender;
      const eligible = location.siblings.map(item => item === location.item ? draft : item)
        .filter(item => !hasGender || !gender || !(item.gender ?? location.parent?.gender) || (item.gender ?? location.parent?.gender) === gender);
      const scale = Math.max(0, ...eligible.map(item => item.weight));
      const total = scale ? eligible.reduce((sum, item) => sum + item.weight / scale, 0) : 0;
      percent.setText(`≈ ${(total ? draft.weight / scale / total * 100 : 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`);
    };
    weight.addEventListener("input", () => { const value = Number(weight.value); if (weight.value.trim() && Number.isSafeInteger(value) && value >= 0) { draft.weight = value; probability(); } });
    name.addEventListener("input", () => resize(name));
    if (hasGender) {
      const select = row.createEl("select", { cls: "cloom-gender-select", attr: { "aria-label": "Пол варианта" } });
      select.createEl("option", { value: "", text: "Любой" });
      for (const gender of genderChoices(this.tables)) if (gender.gender) select.createEl("option", { value: gender.gender, text: gender.value });
      select.value = draft.gender ?? location.parent?.gender ?? "";
      select.addEventListener("change", () => { draft.gender = select.value; probability(); });
    }
    const controls = row.createDiv({ cls: "cloom-choice-actions" });
    const icon = (label: string, name: string) => {
      const button = controls.createEl("button", { cls: "cloom-setting-icon", attr: { type: "button", "aria-label": label, "data-tooltip-position": "top" } });
      setIcon(button, name); return button;
    };
    const save = icon("Сохранить вариант", "save");
    const remove = this.key === "gender" ? undefined : icon("Удалить вариант", "trash-2");
    let text: HTMLTextAreaElement | undefined;
    if (this.key === "backstory-title") {
      body.createEl("label", { cls: "cloom-story-label", text: "Текст предыстории" });
      text = body.createEl("textarea", { cls: "cloom-value-input cloom-story-input", attr: { rows: "4", "aria-label": "Текст предыстории" } });
      text.value = draft.pairedValue ?? "";
      text.addEventListener("input", () => resize(text!));
    }
    const warning = body.createEl("p", { cls: "cloom-delete-warning" });
    let confirming = false;
    let busy = false;
    this.stopDeleteReset?.();
    const resetDelete = (event: MouseEvent) => {
      if (!confirming || busy || !remove || remove.contains(event.target as Node)) return;
      confirming = false;
      setIcon(remove, "trash-2"); remove.removeClass("cloom-confirm-delete");
      remove.setAttribute("aria-label", "Удалить вариант");
      warning.setText("");
    };
    this.modalEl.addEventListener("click", resetDelete, true);
    this.stopDeleteReset = () => this.modalEl.removeEventListener("click", resetDelete, true);
    const submit = async (deleting: boolean) => {
      if (busy) return;
      if (!deleting) {
        if (!name.value.trim()) { new Notice("Введите значение варианта."); return; }
        if (!weight.value.trim() || !Number.isSafeInteger(Number(weight.value)) || Number(weight.value) < 0) { new Notice("Введите целое неотрицательное число."); return; }
        draft.value = clean(name.value); draft.weight = Number(weight.value);
        if (text) draft.pairedValue = clean(text.value);
        if (editableState(draft) === originalState) { this.close(); return; }
      }
      busy = true; save.disabled = true; if (remove) remove.disabled = true;
      try { await this.commit(location, deleting ? undefined : draft); this.close(); }
      catch (error) { console.error("Character Loom variant", error); new Notice(error instanceof Error ? error.message : "Не удалось сохранить вариант."); }
      finally { busy = false; save.disabled = false; if (remove) remove.disabled = false; }
    };
    save.addEventListener("click", () => { void submit(false); });
    remove?.addEventListener("click", () => {
      if (confirming) { void submit(true); return; }
      confirming = true;
      setIcon(remove, "check"); remove.addClass("cloom-confirm-delete");
      remove.setAttribute("aria-label", "Подтвердить удаление варианта");
      warning.setText(`Вариант «${location.item.value}» будет удалён из таблицы «${this.tablePath(location).join(" ▸ ")}». В текущей карточке будет выбран новый вариант.`);
    });
    probability();
    this.resizeWindow = elementWindow(body);
    this.resizeFrame = this.resizeWindow.requestAnimationFrame(() => { resize(name); if (text) resize(text); });
  }

  onClose(): void {
    if (this.resizeFrame !== undefined) this.resizeWindow?.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.stopPositioning?.(); this.stopPositioning = undefined;
    this.stopDeleteReset?.(); this.stopDeleteReset = undefined;
    this.contentEl.empty();
  }
}
