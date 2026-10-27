import { App, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, Platform, Plugin, setIcon } from "obsidian";
import { Choice, fieldLabels, genderFields, rerollLabels, Tables } from "./data";
import { choiceGender, currentGender, genderLabel, generate, generateAll, locateBlock, parseValues, pickForGender, readBlocks, Values } from "./core";
import { knownVariant } from "./variant-presence";
import { matchingVariants, VariantEditor, VariantLocation } from "./variant-editor";
import { CardTarget } from "./card-target";
import { DocumentController } from "./document-controller";
import { GenerationHistoryStore } from "./generation-history";
import { elementWindow, isHTMLElement, registerDocumentEvents } from "./window-events";
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

type IconMotion = { frames: Keyframe[]; started: number; locked?: boolean };
type CardRender = {
  card: HTMLElement;
  target: CardTarget;
  signature: string;
  update(values: Values): void;
  dispose(): void;
  animateLock(motion: IconMotion): void;
  settleLock(): void;
  setControlsLocked(locked: boolean): void;
};
const iconMotionDuration = 350;

export class CardController {
  readonly cards = new Map<HTMLElement, CardTarget>();
  private busyTargets = new Set<string>();
  private lockRequests = new Map<string, { locked: boolean; pending: number }>();
  private editingVariant = false;
  private highlightedBy = new WeakMap<HTMLElement, Set<HTMLElement>>();
  private nameObservers = new Map<HTMLElement, ResizeObserver>();
  private iconMotions = new Map<string, Map<string, IconMotion>>();
  private renders = new WeakMap<HTMLElement, CardRender>();

  constructor(private options: CardOptions) {}

  register(plugin: Plugin): void {
    plugin.register(() => {
      for (const observer of this.nameObservers.values()) observer.disconnect();
      this.nameObservers.clear();
      for (const el of this.cards.keys()) this.renders.get(el)?.dispose();
      this.iconMotions.clear();
    });
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
    for (const path of new Set([...this.cards.values()].map(target => target.path))) this.refreshCards(path, true);
  }

  refreshCards(path: string, rebuild = false): void {
    const editor = this.options.documents.editorFor(path);
    const blocks = editor ? readBlocks(editor.getValue()) : [];
    for (const [el, target] of this.cards) {
      if (target.path !== path) continue;
      const block = editor ? locateBlock(editor.getValue(), target.source, target.lineStart) ?? blocks.find(block => block.lineStart === target.lineStart) : undefined;
      if (editor && !block) continue;
      if (block) { target.source = block.source; target.lineStart = block.lineStart; }
      this.drawCard(el, target, rebuild);
    }
  }

  private preserveControlScroll(button: HTMLElement): () => () => void {
    const capture = () => {
      const positions: Array<{ element: Element; top: number; left: number }> = [];
      for (let element = button.parentElement; element; element = element.parentElement) {
        positions.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      const root = button.ownerDocument.scrollingElement;
      if (root && !positions.some(position => position.element === root)) positions.push({ element: root, top: root.scrollTop, left: root.scrollLeft });
      const editors: Array<() => void> = [];
      this.options.app().workspace.iterateAllLeaves(leaf => {
        if (!(leaf.view instanceof MarkdownView) || !leaf.view.containerEl.contains(button)) return;
        const editor = leaf.view.editor;
        const scroll = editor.getScrollInfo?.();
        if (scroll) editors.push(() => editor.scrollTo(scroll.left, scroll.top));
      });
      return () => {
        for (const { element, top, left } of positions) { element.scrollTop = top; element.scrollLeft = left; }
        for (const restore of editors) restore();
      };
    };
    let pending: (() => void) | undefined;
    button.addEventListener("pointerdown", event => { pending = capture(); event.stopPropagation(); });
    button.addEventListener("pointercancel", () => { pending = undefined; });
    button.addEventListener("mousedown", event => {
      pending ??= capture();
      if (event.button === 0) event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("dblclick", event => { event.preventDefault(); event.stopPropagation(); });
    return () => {
      const restore = pending ?? capture();
      pending = undefined;
      return () => { restore(); elementWindow(button).requestAnimationFrame(restore); };
    };
  }

  private highlightUnknown(element: HTMLElement, target: CardTarget, key: string): void {
    this.updateFieldState(element, target, key);
    const values = parseValues(target.source);
    const tableKey = key === "backstory-text" ? "backstory-title" : key;
    if (this.options.errors().length || element.closest(".markdown-reading-view, .markdown-preview-view")) return;
    if (!values[key]?.trim()) return;
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

  private updateFieldState(element: HTMLElement, target: CardTarget, key: string): void {
    const locked = isCardLocked(target.source);
    const values = parseValues(target.source);
    const tableKey = key === "backstory-text" ? "backstory-title" : key;
    const present = !!values[tableKey]?.trim() || tableKey === "backstory-title" && !!values["backstory-text"]?.trim();
    if (!locked && present && !knownVariant(this.options.tables(), key, values)) element.addClass("cloom-draft-value");
    else element.removeClass("cloom-draft-value");
    const editable = !locked && !this.options.errors().length && !!values[key]?.trim()
      && !element.closest(".markdown-reading-view, .markdown-preview-view");
    if (editable) {
      element.addClass("cloom-editable-value");
      element.setAttribute("tabindex", "0");
      element.setAttribute("aria-haspopup", "dialog");
      element.setAttribute("title", "Редактировать");
    } else {
      element.removeClass("cloom-editable-value");
      if (locked) element.removeClass("cloom-highlighted");
      for (const attribute of ["tabindex", "aria-haspopup", "title"]) element.removeAttribute(attribute);
    }
  }

  private highlightOnInteraction(trigger: HTMLElement, targets: HTMLElement[]): void {
    let hovered = false;
    let focused = false;
    const update = () => {
      const active = !trigger.closest(".cloom-card-locked, .cloom-card-controls-locked")
        && !trigger.matches(":disabled") && (hovered || focused);
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
        if (genderFields.includes(key)) item.gender = choiceGender(draft, parent);
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
      const variantGender = choiceGender(item, parent);
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
        this.nameObservers.get(el)?.disconnect();
        this.nameObservers.delete(el);
        this.cards.delete(el);
        this.renders.get(el)?.dispose();
        this.renders.delete(el);
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

  drawCard(el: HTMLElement, target: CardTarget, rebuild = false): void {
    for (const [cardKey, motions] of this.iconMotions) {
      for (const [key, motion] of motions) {
        if (Date.now() - motion.started >= iconMotionDuration) motions.delete(key);
      }
      if (!motions.size) this.iconMotions.delete(cardKey);
    }
    const cardKey = JSON.stringify([target.path, target.lineStart]);
    const raw = parseValues(target.source);
    const values: Values = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "gender" || this.options.tables()[key === "backstory-text" ? "backstory-title" : key]) values[key] = value;
    }
    const gender = currentGender(this.options.tables(), raw);
    if (!values.gender && gender) values.gender = genderLabel(this.options.tables(), gender) ?? "";
    let locked = isCardLocked(target.source);
    const has = (key: string) => !!values[key] || !!this.options.tables()[key]?.length;
    const showStoryText = !!values["backstory-text"] || !!values["backstory-title"] && !knownVariant(this.options.tables(), "backstory-title", raw);
    const signature = JSON.stringify([target.path, target.lineStart, !!this.options.errors().length,
      !!el.closest(".markdown-reading-view, .markdown-preview-view"),
      [...Object.keys(fieldLabels), "backstory-text"].map(key => [has(key), !!values[key]]), showStoryText]);
    const previous = this.renders.get(el);
    if (previous && !rebuild && previous.signature === signature && el.querySelector(".cloom-card") === previous.card) {
      Object.assign(previous.target, target);
      this.cards.set(el, previous.target);
      previous.update(values);
      return;
    }
    this.nameObservers.get(el)?.disconnect();
    this.nameObservers.delete(el);
    previous?.dispose();
    this.cards.set(el, target);
    el.closest(".cm-embed-block")?.addClass("cloom-embed-block");
    el.empty();
    const textUpdates: Array<{ key: string; update: (value: string) => void }> = [];
    const highlights: Array<{ key: string; element: HTMLElement }> = [];
    const generationButtons: HTMLButtonElement[] = [];
    const highlight = (element: HTMLElement, key: string) => {
      this.highlightUnknown(element, target, key);
      highlights.push({ key, element });
    };
    const text = (container: HTMLElement, key: string, format: (value: string) => string, cls?: string) => {
      const element = container.createSpan({ cls, text: format(values[key] ?? "") });
      textUpdates.push({ key, update: value => element.setText(format(value)) });
      return element;
    };
    const card = el.createDiv({ cls: locked ? "cloom-card cloom-card-locked" : "cloom-card" });
    if (Platform.isMobileApp) card.addClass("cloom-mobile-card");
    let busy = false;
    let updateNameLayout = () => {};
    let nameSeparator: HTMLElement | undefined;
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
    const setupIconMotion = (button: HTMLButtonElement, icon: string, key?: string | string[]) => {
      let animateIcon = () => {};
      const triangle = icon === "cloom-triangle-left" || icon === "cloom-triangle-right";
      if (icon === "cloom-d20" || icon === "refresh-cw" || triangle || icon === "undo-2") {
        const svg = button.querySelector("svg");
        if (svg) {
          svg.classList.add("cloom-roll-icon");
          const motionKey = JSON.stringify([icon, key ?? null]);
          const animate = (motion: IconMotion) => {
            const win = elementWindow(button);
            if (!svg.animate || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
            for (const animation of svg.getAnimations()) animation.cancel();
            const animation = svg.animate(motion.frames, { duration: iconMotionDuration, easing: "ease-out" });
            animation.currentTime = Math.min(iconMotionDuration, Date.now() - motion.started);
          };
          const previous = this.iconMotions.get(cardKey)?.get(motionKey);
          if (previous) animate(previous);
          animateIcon = () => {
            const style = elementWindow(button).getComputedStyle(svg);
            let frames: Keyframe[];
            if (triangle || icon === "undo-2") {
              const distance = icon === "cloom-triangle-left" || icon === "undo-2" ? -3 : 3;
              const stacked = triangle && !!button.closest(".cloom-name-stacked");
              frames = [
                { translate: style.translate === "none" ? "0px 0px" : style.translate },
                { translate: stacked ? `0px ${distance}px` : `${distance}px 0px`, offset: 0.25 },
                { translate: "0px 0px" }
              ];
            } else {
              const from = Number.parseFloat(style.rotate) || 0;
              const to = Math.ceil((from + 180) / 360) * 360;
              frames = [{ rotate: `${from}deg` }, { rotate: `${to}deg` }];
            }
            const motion = { frames, started: Date.now() };
            let motions = this.iconMotions.get(cardKey);
            if (!motions) { motions = new Map(); this.iconMotions.set(cardKey, motions); }
            motions.set(motionKey, motion);
            animate(motion);
          };
        }
      }
      return animateIcon;
    };
    const rerollButton = (container: HTMLElement, key: string | string[] | undefined, label = Array.isArray(key) ? "Внешность" : key ? fieldLabels[key] : "всё", section = false, icon = section ? "refresh-cw" : "cloom-d20") => {
      const button = container.createEl("button", { cls: section ? "cloom-section-button" : "cloom-field-button", attr: { type: "button", "aria-label": rerollLabels[label], title: "" } });
      if (Array.isArray(key)) button.setAttribute("data-reroll-fields", key.join(" "));
      setIcon(button, icon);
      const animateIcon = setupIconMotion(button, icon, key);
      button.disabled = locked;
      generationButtons.push(button);
      if (!button.innerHTML) button.setText("d20");
      const excludeCurrent = !section || key === "quirk" || key === "backstory-title";
      const preserveScroll = this.preserveControlScroll(button);
      button.addEventListener("click", event => {
        event.stopPropagation();
        if (button.disabled) return;
        const restore = preserveScroll();
        animateIcon();
        void reroll(key, excludeCurrent).finally(restore);
      });
      return button;
    };
    const field = (container: HTMLElement, key: string, fallback = false, wholeValue = false): boolean => {
      if (!values[key] && !(fallback && this.options.tables()[key]?.length)) return false;
      const span = container.createSpan({ cls: "cloom-field" });
      const label = fieldLabels[key];
      if (wholeValue) {
        rerollButton(span, key);
        text(span, key, value => value || `[${label}]`);
      } else {
        const split = (value: string) => (value || `[${label}]`).match(/^(\S+)([\s\S]*)$/) ?? ["", value || `[${label}]`, ""];
        const start = span.createSpan({ cls: "cloom-field-start" });
        rerollButton(start, key);
        text(start, key, value => split(value)[1], "cloom-field-text");
        text(span, key, value => split(value)[2]);
      }
      highlight(span, key);
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
    const identity = card.createEl("header", { cls: "cloom-identity" });
    const nameRow = identity.createDiv({ cls: "cloom-identity-heading" });
    const undo = nameRow.createEl("button", { cls: "cloom-section-button cloom-undo-button", attr: { type: "button", "aria-label": "Отменить действие", title: "Отменить действие (Ctrl+Z)" } });
    setIcon(undo, "undo-2");
    const animateUndo = setupIconMotion(undo, "undo-2");
    undo.disabled = locked || !this.options.documents.editorFor(target.path);
    const preserveUndoScroll = this.preserveControlScroll(undo);
    undo.addEventListener("click", event => {
      event.stopPropagation();
      if (isCardLocked(target.source)) { new Notice(lockedNotice); return; }
      if (busy || undo.disabled) return;
      const restore = preserveUndoScroll();
      animateUndo();
      busy = true;
      void (async () => {
        try {
          if (!await this.options.documents.undo(target.path)) new Notice("Character Loom: откройте заметку в режиме редактирования для отмены действия.");
        } catch (error) { this.options.report(error); }
        finally { restore(); busy = false; }
      })();
    });
    if (has("name") || has("surname")) {
      const fullName = nameRow.createEl("h2", { cls: "cloom-name" });
      if (has("name")) {
        highlight(text(fullName, "name", value => value || "[Имя]", "cloom-given-name"), "name");
        fullName.appendText(" ");
      }
      const controls = fullName.createSpan({ cls: "cloom-name-controls" });
      if (has("name")) rerollButton(controls, ["name"], "Имя", false, "cloom-triangle-left");
      rerollButton(controls, ["name", "surname"].filter(has), "Имя и фамилия");
      if (has("surname")) rerollButton(controls, ["surname"], "Фамилия", false, "cloom-triangle-right");
      nameSeparator = controls.createSpan({ cls: "cloom-name-separator", attr: { "aria-hidden": "true" } });
      if (has("surname")) {
        highlight(text(fullName, "surname", value => value || "[Фамилия]", "cloom-surname"), "surname");
      }
      controls.querySelectorAll<HTMLElement>("button[data-reroll-fields]").forEach(button => {
        const targets: HTMLElement[] = [];
        for (const key of (button.getAttribute("data-reroll-fields") ?? "").split(" ")) {
          const value = fullName.querySelector<HTMLElement>(key === "name" ? ".cloom-given-name" : ".cloom-surname");
          if (value) targets.push(value);
        }
        this.highlightOnInteraction(button, targets);
      });
      updateNameLayout = () => {
        nameRow.removeClass("cloom-identity-heading-stacked");
        fullName.removeClass("cloom-name-stacked");
        fullName.addClass("cloom-name-measuring");
        const names = fullName.querySelectorAll<HTMLElement>(".cloom-given-name, .cloom-surname");
        const needsStack = Array.from(names).some(name => {
          const range = name.ownerDocument.createRange();
          range.selectNodeContents(name);
          return name.scrollWidth > name.clientWidth
            || range.getBoundingClientRect().width > name.getBoundingClientRect().width;
        })
          || controls.scrollWidth > fullName.clientWidth;
        fullName.removeClass("cloom-name-measuring");
        if (needsStack) {
          nameRow.addClass("cloom-identity-heading-stacked");
          fullName.addClass("cloom-name-stacked");
        }
      };
      const observer = new (elementWindow(fullName).ResizeObserver)(updateNameLayout);
      observer.observe(nameRow);
      observer.observe(fullName);
      this.nameObservers.set(el, observer);
    }
    const actions = nameRow.createDiv({ cls: "cloom-card-actions" });
    const lock = actions.createEl("button", { cls: "cloom-section-button cloom-lock-button", attr: {
      type: "button", "aria-label": locked ? "Разблокировать карточку" : "Заблокировать карточку",
      title: "", "aria-pressed": String(locked)
    } });
    setIcon(lock, locked ? "lock" : "lock-open");
    let playingLockMotion: IconMotion | undefined;
    let lockFrame: number | undefined;
    const stopLockAnimation = () => {
      if (lockFrame !== undefined) elementWindow(lock).cancelAnimationFrame(lockFrame);
      lockFrame = undefined;
    };
    const settleLock = () => {
      stopLockAnimation();
      lock.empty();
      const requested = this.lockRequests.get(`${target.path}:${target.lineStart}`);
      setIcon(lock, (requested?.locked ?? isCardLocked(target.source)) ? "lock" : "lock-open");
    };
    const animateLock = (motion: IconMotion) => {
      const win = elementWindow(lock);
      if (playingLockMotion === motion || motion.locked === undefined) return;
      stopLockAnimation();
      playingLockMotion = motion;
      if (!lock.animate || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        lock.empty();
        setIcon(lock, motion.locked ? "lock" : "lock-open");
        return;
      }
      lock.empty();
      const icon = lock.createSpan({ cls: "cloom-lock-icon" });
      const closing = motion.locked;
      let displayedLocked: boolean | undefined;
      const tick = () => {
        if (playingLockMotion !== motion) return;
        const progress = Math.max(0, Math.min(1, (Date.now() - motion.started) / iconMotionDuration));
        const leg = progress < 0.4 ? progress / 0.4 : progress > 0.6 ? (1 - progress) / 0.4 : 1;
        const distance = (closing ? -3 : 3) * (1 - Math.cos(Math.PI * leg)) / 2;
        icon.style.translate = `0px ${distance}px`;
        const nextLocked = progress >= 0.5 ? closing : !closing;
        if (displayedLocked !== nextLocked) {
          displayedLocked = nextLocked;
          icon.empty();
          setIcon(icon, nextLocked ? "lock" : "lock-open");
        }
        if (progress >= 1) {
          stopLockAnimation();
          if (this.iconMotions.get(cardKey)?.get("lock") === motion) this.iconMotions.get(cardKey)?.delete("lock");
          return;
        }
        lockFrame = win.requestAnimationFrame(tick);
      };
      tick();
    };
    const previousLockMotion = this.iconMotions.get(cardKey)?.get("lock");
    if (previousLockMotion) animateLock(previousLockMotion);
    else settleLock();
    lock.addEventListener("mousedown", event => {
      if (event.button === 0) event.preventDefault();
      event.stopPropagation();
    });
    lock.addEventListener("click", event => {
      event.stopPropagation();
      const id = `${target.path}:${target.lineStart}`;
      const pending = this.lockRequests.get(id);
      if (!pending && (busy || this.busyTargets.has(id))) return;
      const closing = !(pending?.locked ?? isCardLocked(target.source));
      const request = pending ?? { locked: closing, pending: 0 };
      request.locked = closing;
      request.pending++;
      this.lockRequests.set(id, request);
      for (const [host, other] of this.cards) {
        if (other.path === target.path && other.lineStart === target.lineStart) this.renders.get(host)?.setControlsLocked(true);
      }
      const motion: IconMotion = {
        started: Date.now(), locked: closing,
        frames: [
          { translate: "0px 0px" },
          { translate: `0px ${closing ? -3 : 3}px`, offset: 0.4 },
          { translate: `0px ${closing ? -3 : 3}px`, offset: 0.6 },
          { translate: "0px 0px" }
        ]
      };
      let motions = this.iconMotions.get(cardKey);
      if (!motions) { motions = new Map(); this.iconMotions.set(cardKey, motions); }
      motions.set("lock", motion);
      for (const [host, other] of this.cards) {
        if (other.path === target.path && other.lineStart === target.lineStart) this.renders.get(host)?.animateLock(motion);
      }
      animateLock(motion);
      if (pending) return;
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
        let updated = false;
        try {
          while (request.pending > 0) {
            request.pending--;
            const previousSource = target.source;
            updated = await this.options.documents.updateTarget(target, undefined, "toggle-lock");
            if (!updated) {
              new Notice("Character Loom: блок изменился или не найден. Переключите режим заметки и повторите.");
              break;
            }
            for (const other of this.cards.values()) {
              if (other.path === target.path && other.lineStart === target.lineStart && other.source === previousSource) other.source = target.source;
            }
            this.refreshCards(target.path);
          }
          if (updated) new Notice(isCardLocked(target.source) ? "Редактирование персонажа заблокировано" : "Разблокировано");
        } catch (error) { updated = false; this.options.report(error); }
        finally {
          this.lockRequests.delete(id);
          this.refreshCards(target.path);
          if (!updated) {
            this.iconMotions.get(cardKey)?.delete("lock");
            for (const [host, other] of this.cards) {
              if (other.path === target.path && other.lineStart === target.lineStart) this.renders.get(host)?.settleLock();
            }
          }
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
        const item = heading.createSpan({ cls: "cloom-meta-item" });
        if (index) item.createSpan({ cls: "cloom-separator", text: " · ", attr: { "aria-hidden": "true" } });
        field(item, key, true, true);
      });
    }
    const paragraph = (container: HTMLElement, key: string, placeholder: string, cls?: string) => {
      const element = container.createEl("p", { cls, text: values[key] || placeholder });
      textUpdates.push({ key, update: value => element.setText(value || placeholder) });
      highlight(element, key);
    };
    if (has("quirk")) paragraph(section("Странность", "quirk"), "quirk", "[Странность]");
    const description = appearanceKeys.some(has) ? section("Внешность", appearanceKeys).createEl("p", { cls: "cloom-description" }) : undefined;
    if (description) {
      const suffix = (key: string, format: (value: string) => string) => {
        text(description, key, format);
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
        description.createSpan({ cls: "cloom-appearance-prefix", text: "У персонажа" });
        description.appendText(" ");
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
      paragraph(story, "backstory-title", "[Название предыстории]", "cloom-story-title");
      if (showStoryText) paragraph(story, "backstory-text", "[Текст предыстории]");
    }
    const setControlsLocked = (controlsLocked: boolean) => {
      if (controlsLocked) {
        card.addClass("cloom-card-controls-locked");
        card.querySelectorAll<HTMLElement>(".cloom-highlighted").forEach(element => {
          element.removeClass("cloom-highlighted");
          this.highlightedBy.delete(element);
        });
      } else card.removeClass("cloom-card-controls-locked");
      for (const button of generationButtons) {
        button.disabled = controlsLocked;
        button.hidden = controlsLocked;
      }
      undo.disabled = controlsLocked || !this.options.documents.editorFor(target.path);
      undo.hidden = controlsLocked;
      nameSeparator?.setText(controlsLocked ? " · " : "");
      if (controlsLocked) nameRow.addClass("cloom-identity-controls-locked");
      else nameRow.removeClass("cloom-identity-controls-locked");
    };
    setControlsLocked(locked || this.lockRequests.has(`${target.path}:${target.lineStart}`));
    this.renders.set(el, { card, target, signature, dispose: stopLockAnimation, animateLock, settleLock, setControlsLocked, update: next => {
      const nextLocked = isCardLocked(target.source);
      if (nextLocked !== locked) {
        locked = nextLocked;
        if (locked) card.addClass("cloom-card-locked");
        else card.removeClass("cloom-card-locked");
        lock.setAttribute("aria-label", locked ? "Разблокировать карточку" : "Заблокировать карточку");
        lock.setAttribute("aria-pressed", String(locked));
        const motion = this.iconMotions.get(cardKey)?.get("lock");
        if (motion) animateLock(motion);
        else if (!this.lockRequests.has(`${target.path}:${target.lineStart}`)) settleLock();
      }
      for (const { key, update } of textUpdates) {
        if (values[key] !== next[key]) update(next[key] ?? "");
      }
      if (values.name !== next.name || values.surname !== next.surname) updateNameLayout();
      for (const { key, element } of highlights) this.updateFieldState(element, target, key);
      setControlsLocked(locked || this.lockRequests.has(`${target.path}:${target.lineStart}`));
      for (const key of Object.keys(values)) delete values[key];
      Object.assign(values, next);
    } });
  }
}
