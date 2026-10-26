import { MarkdownView, Plugin, Workspace } from "obsidian";
import { CardTarget } from "./card-target";
import { applyValues, Values } from "./core";
import { isCardLocked, setCardLocked } from "./card-lock";

export type GenerationHistory = { source: string; states: string[] };
export type HistoryChange = { source: string; rollback(): void };

export class GenerationHistoryStore {
  private readonly records = new Map<string, GenerationHistory>();
  private historyCleanupTimer?: number;

  constructor(private workspace: () => Workspace) {}

  get size(): number { return this.records.size; }

  forTarget(target: CardTarget): GenerationHistory | undefined {
    const history = this.records.get(`${target.path}:${target.lineStart}`);
    return history?.source.trimEnd() === target.source.trimEnd() ? history : undefined;
  }

  prepare(target: CardTarget, updates: Values | undefined, action?: "generate" | "undo" | "toggle-lock"): HistoryChange | undefined {
    const previous = this.forTarget(target);
    let source: string;
    let history: GenerationHistory | undefined;
    if (action === "toggle-lock") {
      const locked = !isCardLocked(target.source);
      source = setCardLocked(target.source, locked);
      if (previous) history = { source, states: previous.states.map(state => setCardLocked(state, locked)) };
    } else if (action === "undo") {
      if (!previous?.states.length) return;
      source = previous.states[previous.states.length - 1];
      history = { source, states: previous.states.slice(0, -1) };
    } else {
      source = applyValues(target.source, updates ?? {});
      if (action === "generate" && source !== target.source) {
        history = { source, states: [...(previous?.states ?? []), target.source].slice(-3) };
      }
    }
    if (!history) return { source, rollback() {} };
    const key = `${target.path}:${target.lineStart}`;
    const previousHistory = this.records.get(key);
    // A synchronous editor redraw must see the pending history; failed writes restore it.
    this.records.set(key, history);
    return { source, rollback: () => {
      if (this.records.get(key) !== history) return;
      if (previousHistory) this.records.set(key, previousHistory);
      else this.records.delete(key);
    } };
  }

  private scheduleCleanup(): void {
    if (this.historyCleanupTimer !== undefined) window.clearTimeout(this.historyCleanupTimer);
    this.historyCleanupTimer = window.setTimeout(() => {
      this.historyCleanupTimer = undefined;
      const openPaths = new Set<string>();
      this.workspace().iterateAllLeaves(leaf => {
        const path = leaf.view instanceof MarkdownView ? leaf.view.file?.path : leaf.getViewState().state?.file;
        if (typeof path === "string") openPaths.add(path);
      });
      for (const key of this.records.keys()) {
        if (!openPaths.has(key.slice(0, key.lastIndexOf(":")))) this.records.delete(key);
      }
    }, 0);
  }

  private move(oldPath: string, newPath?: string): void {
    const moved: Array<[string, GenerationHistory]> = [];
    const matches = (path: string) => path === oldPath || path.startsWith(`${oldPath}/`);
    for (const [key, history] of this.records) {
      const separator = key.lastIndexOf(":");
      const path = key.slice(0, separator);
      if (!matches(path)) continue;
      this.records.delete(key);
      if (newPath !== undefined) moved.push([newPath + path.slice(oldPath.length) + key.slice(separator), history]);
    }
    for (const [key, history] of moved) this.records.set(key, history);
  }

  register(plugin: Plugin, moveCards: (oldPath: string, newPath: string) => void): void {
    plugin.registerEvent(plugin.app.workspace.on("file-open", () => this.scheduleCleanup()));
    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => this.scheduleCleanup()));
    plugin.registerEvent(plugin.app.vault.on("delete", file => this.move(file.path)));
    plugin.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => {
      this.move(oldPath, file.path);
      moveCards(oldPath, file.path);
    }));
    plugin.register(() => {
      if (this.historyCleanupTimer !== undefined) window.clearTimeout(this.historyCleanupTimer);
      this.records.clear();
    });
  }
}
