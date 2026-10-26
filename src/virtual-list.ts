import { elementWindow } from "./window-events";

export const SETTINGS_PAGE_SIZE = 10;

export type ListWindow = {
  loaded: number;
  heights: number[];
  mounted: Set<number>;
};

type Page = { el: HTMLElement; index: number; mounted: boolean; visible: boolean };
type Options<T> = {
  root: HTMLElement;
  container: HTMLElement;
  items: T[];
  state: ListWindow;
  focusIndex?: number;
  render: (container: HTMLElement, item: T) => void;
  release: (container: HTMLElement) => void;
  updated: () => void;
};

/** Keeps lightweight measured placeholders for pages outside the viewport. */
export class VirtualSettingsList<T> {
  readonly container: HTMLElement;
  private pages: Page[] = [];
  private sentinel?: HTMLElement;
  private disposed = false;
  private intersections: IntersectionObserver;
  private measurements: ResizeObserver;

  constructor(private options: Options<T>) {
    this.container = options.container;
    this.intersections = new (elementWindow(this.container).IntersectionObserver)(entries => {
      if (this.disposed) return;
      for (const entry of entries) {
        if (entry.target === this.sentinel) {
          if (entry.isIntersecting) this.loadNext();
          continue;
        }
        const page = this.pages.find(page => page.el === entry.target);
        if (!page) continue;
        page.visible = entry.isIntersecting;
        if (page.visible) this.mount(page);
        else this.unmount(page);
      }
    }, { root: options.root, rootMargin: "150px 0px" });
    this.measurements = new (elementWindow(this.container).ResizeObserver)(entries => {
      if (this.disposed) return;
      for (const entry of entries) {
        const page = this.pages.find(page => page.el === entry.target);
        if (page?.mounted && entry.contentRect.height > 0) options.state.heights[page.index] = entry.contentRect.height;
      }
    });
    this.container.addEventListener("focusout", this.releaseUnfocused);
    const focusIndex = options.focusIndex !== undefined && options.focusIndex >= 0 ? options.focusIndex : undefined;
    const requested = focusIndex === undefined ? 0 : Math.ceil((focusIndex + 1) / SETTINGS_PAGE_SIZE) * SETTINGS_PAGE_SIZE;
    options.state.loaded = Math.min(options.items.length, Math.max(SETTINGS_PAGE_SIZE, options.state.loaded, requested));
    if (focusIndex !== undefined) options.state.mounted.add(Math.floor(focusIndex / SETTINGS_PAGE_SIZE));
    for (let index = 0; index < Math.ceil(options.state.loaded / SETTINGS_PAGE_SIZE); index++) this.createPage(index);
    this.observeEnd();
  }

  private createPage(index: number, mount = false): void {
    const el = this.container.createDiv({ cls: "cloom-choice-page" });
    const page: Page = { el, index, mounted: false, visible: false };
    this.pages.push(page);
    el.setCssStyles({ minHeight: `${this.options.state.heights[index] ?? 510}px` });
    if (mount || this.options.state.mounted.has(index)) this.mount(page);
    this.intersections.observe(el);
  }

  private mount(page: Page): void {
    if (this.disposed || page.mounted) return;
    page.mounted = true;
    this.options.state.mounted.add(page.index);
    page.el.setCssStyles({ minHeight: "" });
    const start = page.index * SETTINGS_PAGE_SIZE;
    for (const item of this.options.items.slice(start, start + SETTINGS_PAGE_SIZE)) this.options.render(page.el, item);
    this.measurements.observe(page.el);
    this.options.updated();
  }

  private unmount(page: Page): void {
    if (!page.mounted || page.el.contains(page.el.ownerDocument.activeElement)) return;
    const height = page.el.getBoundingClientRect().height;
    // A collapsed ancestor has no measurable height; retain the previous measurement.
    if (height > 0) this.options.state.heights[page.index] = height;
    const measured = this.options.state.heights[page.index];
    if (!measured) return;
    this.measurements.unobserve(page.el);
    this.options.release(page.el);
    page.el.empty();
    page.el.setCssStyles({ minHeight: `${measured}px` });
    page.mounted = false;
    this.options.state.mounted.delete(page.index);
  }

  private releaseUnfocused = (): void => {
    elementWindow(this.container).setTimeout(() => {
      if (!this.disposed) for (const page of this.pages) if (!page.visible) this.unmount(page);
    }, 0);
  };

  private observeEnd(): void {
    if (this.sentinel) { this.intersections.unobserve(this.sentinel); this.sentinel.remove(); this.sentinel = undefined; }
    if (this.options.state.loaded >= this.options.items.length) return;
    this.sentinel = this.container.createDiv({ cls: "cloom-load-sentinel", attr: { "aria-hidden": "true" } });
    this.intersections.observe(this.sentinel);
  }

  private loadNext(): void {
    if (this.disposed || this.options.state.loaded >= this.options.items.length) return;
    if (this.sentinel) { this.intersections.unobserve(this.sentinel); this.sentinel.remove(); this.sentinel = undefined; }
    const index = this.pages.length;
    this.options.state.loaded = Math.min(this.options.items.length, this.options.state.loaded + SETTINGS_PAGE_SIZE);
    this.createPage(index, true);
    this.observeEnd();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.intersections.disconnect();
    this.measurements.disconnect();
    this.container.removeEventListener("focusout", this.releaseUnfocused);
    for (const page of this.pages) {
      if (!page.mounted) continue;
      const height = page.el.getBoundingClientRect().height;
      if (height > 0) this.options.state.heights[page.index] = height;
      this.options.release(page.el);
    }
  }
}
