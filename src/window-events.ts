import { Plugin } from "obsidian";

type Listen = <K extends keyof DocumentEventMap>(type: K, listener: (event: DocumentEventMap[K]) => void, options?: boolean) => void;

export function registerDocumentEvents(plugin: Plugin, setup: (doc: Document, listen: Listen) => void): void {
  const documents = new Map<Document, () => void>();
  const closed = new WeakSet<Document>();
  let disposed = false;
  const add = (doc: Document) => {
    if (disposed || closed.has(doc) || documents.has(doc)) return;
    const cleanups: Array<() => void> = [];
    documents.set(doc, () => cleanups.forEach(cleanup => cleanup()));
    setup(doc, (type, listener, options) => {
      doc.addEventListener(type, listener, options);
      cleanups.push(() => doc.removeEventListener(type, listener, options));
    });
  };
  const scan = () => {
    if (disposed) return;
    add(plugin.app.workspace.containerEl.ownerDocument);
    plugin.app.workspace.iterateAllLeaves(leaf => add(leaf.view.containerEl.ownerDocument));
  };
  scan();
  plugin.app.workspace.onLayoutReady(scan);
  plugin.registerEvent(plugin.app.workspace.on("layout-change", scan));
  plugin.registerEvent(plugin.app.workspace.on("window-open", (_container, win) => {
    closed.delete(win.document);
    add(win.document);
  }));
  plugin.registerEvent(plugin.app.workspace.on("window-close", (_container, win) => {
    documents.get(win.document)?.();
    documents.delete(win.document);
    closed.add(win.document);
  }));
  plugin.register(() => {
    disposed = true;
    for (const cleanup of documents.values()) cleanup();
    documents.clear();
  });
}

export function isHTMLElement(target: EventTarget | null | undefined): target is HTMLElement {
  const node = target as Node | null | undefined;
  return !!node && typeof node.instanceOf === "function" && node.instanceOf(HTMLElement);
}

export function elementWindow(element: HTMLElement): Window & typeof window {
  return element.win as Window & typeof window;
}
