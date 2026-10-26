import { App, Editor, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { genderFields, Tables } from "./data";
import { applyValues, Block, currentGender, locateBlock, parseValues, pickForGender, readBlocks, valueGender, Values } from "./core";
import { CardTarget } from "./card-target";
import { HistoryChange, GenerationHistoryStore } from "./generation-history";
import { isHTMLElement, registerDocumentEvents } from "./window-events";
import { isCardLocked, lockedNotice } from "./card-lock";

const afterEditorUpdate = () => new Promise<void>(resolve => setTimeout(resolve, 0));
type DocumentOptions = {
  app(): App;
  tables(): Tables;
  history: GenerationHistoryStore;
  refreshCards(path: string): void;
  report(error: unknown): void;
};

export class DocumentController {
  readonly snapshots = new WeakMap<Editor, string>();
  readonly validating = new WeakSet<Editor>();
  private writing = new WeakSet<Editor>();

  constructor(private options: DocumentOptions) {}

  register(plugin: Plugin): void {
    const remember = () => {
      const view = this.options.app().workspace.getActiveViewOfType(MarkdownView);
      if (view && !this.snapshots.has(view.editor)) this.snapshots.set(view.editor, view.editor.getValue());
    };
    this.options.app().workspace.onLayoutReady(remember);
    plugin.registerEvent(this.options.app().workspace.on("active-leaf-change", remember));
    plugin.registerEvent(this.options.app().workspace.on("file-open", () => {
      const view = this.options.app().workspace.getActiveViewOfType(MarkdownView);
      if (view) this.snapshots.set(view.editor, view.editor.getValue());
    }));
    registerDocumentEvents(plugin, (doc, listen) => {
      listen("focusin", event => {
        if (!isHTMLElement(event.target)) return;
        const target = event.target;
        this.options.app().workspace.iterateAllLeaves(leaf => {
          const view = leaf.view;
          if (view instanceof MarkdownView && view.containerEl.contains(target) && !this.snapshots.has(view.editor)) {
            this.snapshots.set(view.editor, view.editor.getValue());
          }
        });
      });
      listen("focusout", event => {
        const target = event.target;
        if (!isHTMLElement(target) || !target.closest(".markdown-source-view")) return;
        this.options.app().workspace.iterateAllLeaves(leaf => {
          const view = leaf.view;
          if (view instanceof MarkdownView && view.containerEl.contains(target)) {
            void this.validateEditor(view).catch(error => this.options.report(error));
          }
        });
      });
      const checkEditors = (event?: Event) => {
        if (isHTMLElement(event?.target) && event.target.closest(".modal-container")) return;
        this.options.app().workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof MarkdownView && leaf.view.containerEl.ownerDocument === doc) void this.validateEditor(leaf.view, true).catch(error => this.options.report(error)); });
      };
      listen("pointerup", checkEditors);
      listen("keyup", checkEditors);
    });
    plugin.registerEvent(this.options.app().workspace.on("editor-change", (_editor, info) => { if (info instanceof MarkdownView) void this.validateEditor(info, true).catch(error => this.options.report(error)); }));
  }

  editorFor(path: string): Editor | undefined {
    let editor: Editor | undefined;
    this.options.app().workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.getMode() === "source") editor ??= leaf.view.editor;
    });
    return editor;
  }

  async updateTarget(target: CardTarget, updates: Values | undefined, action?: "generate" | "undo" | "toggle-lock"): Promise<boolean> {
    // Code-block processors also run inside CodeMirror's update. Dispatch in the next task,
    // then resolve the block against the latest document so intervening edits are preserved.
    await afterEditorUpdate();
    if (target.currentLine) target.lineStart = target.currentLine();
    let next: string | undefined;
    let lineStart: number | undefined;
    let change: HistoryChange | undefined;
    const prepare = (block: Block): string | undefined => {
      if (action !== "toggle-lock" && isCardLocked(block.source)) {
        new Notice(lockedNotice);
        return undefined;
      }
      change = this.options.history.prepare({ ...target, source: block.source, lineStart: block.lineStart }, updates, action);
      next = change?.source;
      lineStart = block.lineStart;
      return next;
    };
    const replace = (text: string): string => {
      const block = locateBlock(text, target.source, target.lineStart);
      if (!block) return text;
      if (prepare(block) === undefined) return text;
      return text.slice(0, block.from) + next + text.slice(block.to);
    };
    try {
      const editor = this.editorFor(target.path);
      if (editor) {
        const document = editor.getValue();
        const block = locateBlock(document, target.source, target.lineStart);
        if (!block) return false;
        const replacement = prepare(block);
        if (replacement === undefined) return false;
        this.writeEditorBlock(editor, block, replacement, action === "toggle-lock");
      } else {
        const file = this.options.app().vault.getAbstractFileByPath(target.path);
        if (!(file instanceof TFile)) return false;
        await this.options.app().vault.process(file, replace);
      }
    } catch (error) {
      change?.rollback();
      throw error;
    }
    if (next === undefined) return false;
    target.source = next;
    target.lineStart = lineStart;
    return true;
  }

  private writeEditorBlock(editor: Editor, block: Block, next: string, minimal = false): void {
    if (next === block.source) return;
    this.writing.add(editor);
    try {
      let start = 0;
      let oldEnd = block.source.length;
      let newEnd = next.length;
      if (minimal) {
        while (start < oldEnd && start < newEnd && block.source[start] === next[start]) start++;
        while (oldEnd > start && newEnd > start && block.source[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
      }
      editor.replaceRange(next.slice(start, newEnd), editor.offsetToPos(block.from + start), editor.offsetToPos(block.from + oldEnd));
      this.snapshots.set(editor, editor.getValue());
    } finally {
      this.writing.delete(editor);
    }
  }

  async validateEditor(view: MarkdownView, skipActiveBlock = false): Promise<void> {
    const editor = view.editor;
    if (this.validating.has(editor) || this.writing.has(editor) || !view.file) return;
    const path = view.file.path;
    this.validating.add(editor);
    let changed = false;
    try {
      // Focus can leave a widget while CodeMirror is updating or replacing its DOM.
      await afterEditorUpdate();
      if (view.file?.path !== path) return;
      const before = this.snapshots.get(editor);
      if (before === undefined) return;
      if (before === editor.getValue()) return;
      changed = true;
      const oldBlocks = readBlocks(before);
      const editedBlocks = readBlocks(editor.getValue());
      const deferred: Array<{ index: number; source: string }> = [];
      for (const [index, original] of editedBlocks.entries()) {
        let source = original.source;
        const previousBlock = oldBlocks.length === editedBlocks.length ? oldBlocks[index] : undefined;
        // Without a matching baseline, saved values are not evidence of manual edits.
        if (!previousBlock) continue;
        if (isCardLocked(previousBlock.source)) {
          if (original.source !== previousBlock.source) {
            const latest = readBlocks(editor.getValue())[index];
            if (!latest || latest.source !== source) return;
            this.writeEditorBlock(editor, latest, previousBlock.source);
            new Notice("Изменения отменены из-за заблокированной карточки.");
          }
          continue;
        }
        const previous = parseValues(previousBlock.source);
        if (!Object.values(previous).some(Boolean)) continue;
        const cursor = editor.getCursor?.();
        if (skipActiveBlock && cursor && view.containerEl.contains(view.containerEl.ownerDocument.activeElement) && cursor.line > original.lineStart && cursor.line <= original.lineStart + original.source.split("\n").length) {
          if (previousBlock.source !== original.source) deferred.push({ index, source: previousBlock.source });
          continue;
        }
        const values = parseValues(source);
        const synchronized = new Set<string>();
        for (const key of Object.keys(values).sort((a, b) => Number(b === "gender") - Number(a === "gender"))) {
          const value = values[key];
          if (synchronized.has(key)) continue;
          if (value === previous[key] || !value) continue;
          if (key === "gender") {
            const gender = valueGender(this.options.tables(), "gender", value);
            const updates: Values = {};
            if (gender) {
              for (const pairedKey of genderFields) {
                if (pairedKey === "surname") {
                  const surnameGender = valueGender(this.options.tables(), pairedKey, values[pairedKey]);
                  if (!surnameGender || surnameGender === gender) continue;
                }
                const paired = pickForGender(this.options.tables()[pairedKey] ?? [], gender);
                updates[pairedKey] = paired?.value ?? "";
              }
            } else updates.gender = previous.gender ?? "";
            if (updates.gender !== undefined) {
              for (const pairedKey of genderFields) delete updates[pairedKey];
              new Notice("Выберите пол из таблицы «Пол».");
            }
            await afterEditorUpdate();
            if (view.file?.path !== path) return;
            const latest = readBlocks(editor.getValue())[index];
            if (!latest || latest.source !== source || editedBlocks.length !== readBlocks(editor.getValue()).length) return;
            source = applyValues(source, updates);
            this.writeEditorBlock(editor, latest, source);
            Object.assign(values, updates);
            Object.keys(updates).forEach(key => synchronized.add(key));
            continue;
          }
          const tableKey = key === "backstory-text" ? "backstory-title" : key;
          if (!this.options.tables()[tableKey]) continue;
          if (!genderFields.includes(key)) continue;
          if (view.file?.path !== path) return;
          const current = readBlocks(editor.getValue())[index];
          if (!current || current.source !== source || editedBlocks.length !== readBlocks(editor.getValue()).length) return;
          const updates: Values = {};
          const gender = valueGender(this.options.tables(), key, value);
          if (values.gender && gender && gender !== currentGender(this.options.tables(), values)) {
            updates[key] = previous[key] ?? "";
            new Notice("Вариант не соответствует полу персонажа. Сначала измените gender.");
          } else if (gender) {
            for (const other of genderFields.filter(field => field !== key)) {
              const otherGender = valueGender(this.options.tables(), other, values[other]);
              if ((values[other] && (!otherGender || otherGender === gender)) || (other === "surname" && !values[other])) continue;
              const paired = pickForGender(this.options.tables()[other] ?? [], gender);
              updates[other] = paired?.value ?? "";
            }
          }
          // Resume editor writes outside the current view update.
          if (Object.keys(updates).length) await afterEditorUpdate();
          if (view.file?.path !== path) return;
          const latest = readBlocks(editor.getValue())[index];
          if (!latest || latest.source !== source) return;
          if (Object.keys(updates).length) {
            source = applyValues(source, updates);
            this.writeEditorBlock(editor, latest, source);
            Object.assign(values, updates);
            Object.keys(updates).forEach(key => synchronized.add(key));
          }
        }
      }
      let snapshot = editor.getValue();
      for (const skip of [...deferred].reverse()) { const block = readBlocks(snapshot)[skip.index]; if (block) snapshot = snapshot.slice(0, block.from) + skip.source + snapshot.slice(block.to); }
      this.snapshots.set(editor, snapshot);
    } finally {
      this.validating.delete(editor);
      if (changed) this.options.refreshCards(path);
    }
  }
}
