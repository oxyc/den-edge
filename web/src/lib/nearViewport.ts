type NearCallback = (near: boolean) => void;
type ObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit,
) => IntersectionObserver;

interface Group {
  observer: IntersectionObserver;
  callbacks: Map<Element, Set<NearCallback>>;
  state: Map<Element, boolean>;
}

/**
 * One IntersectionObserver per margin, shared by every row and card using that visibility window.
 * Removing the final target also releases the observer, so retained and destroyed pages leave no watcher behind.
 */
export class NearViewportObservers {
  private readonly groups = new Map<string, Group>();

  constructor(
    private readonly create: ObserverFactory = (callback, options) =>
      new IntersectionObserver(callback, options),
  ) {}

  observe(element: Element, callback: NearCallback, rootMargin: string): () => void {
    let group = this.groups.get(rootMargin);
    if (!group) {
      const callbacks = new Map<Element, Set<NearCallback>>();
      const state = new Map<Element, boolean>();
      const observer = this.create(
        (entries) => {
          for (const entry of entries) {
            state.set(entry.target, entry.isIntersecting);
            for (const notify of callbacks.get(entry.target) ?? []) notify(entry.isIntersecting);
          }
        },
        { rootMargin },
      );
      group = { observer, callbacks, state };
      this.groups.set(rootMargin, group);
    }

    let listeners = group.callbacks.get(element);
    if (!listeners) {
      listeners = new Set();
      group.callbacks.set(element, listeners);
      group.observer.observe(element);
    }
    listeners.add(callback);
    const known = group.state.get(element);
    if (known !== undefined) callback(known);

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = this.groups.get(rootMargin);
      const remaining = current?.callbacks.get(element);
      remaining?.delete(callback);
      if (remaining?.size) return;
      current?.callbacks.delete(element);
      current?.state.delete(element);
      current?.observer.unobserve(element);
      if (current?.callbacks.size) return;
      current?.observer.disconnect();
      this.groups.delete(rootMargin);
    };
  }
}

const viewportObservers = new NearViewportObservers();

/** Observe an element against the viewport, using the shared observer for `rootMargin`. */
export function observeNearViewport(
  element: Element,
  callback: NearCallback,
  rootMargin: string,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    callback(true);
    return () => {};
  }
  return viewportObservers.observe(element, callback, rootMargin);
}
