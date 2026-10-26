import { LIBRARY_SERVICE_WIRE_LIMITS, type TitleRef } from './libraryServiceProtocol';

const key = (title: TitleRef) => `${title.type}:${title.id}`;

/**
 * One History snapshot's bounded detail-query state. A failed title is latched until the snapshot changes: an
 * unavailable Worker must not turn a reactive render effect into an unbounded request loop.
 */
export class HistoryDetailRequests {
  readonly #pending = new Set<string>();
  readonly #failed = new Set<string>();

  take(
    titles: readonly TitleRef[],
    loaded: ReadonlyMap<string, unknown>,
  ): Array<TitleRef & { type: 'tv' }> {
    // Read reactive loaded state on every call, including while a request is pending. Otherwise a Svelte effect that
    // reruns during the request can drop its SvelteMap dependency and never run again when this batch is stored.
    const loadedSize = loaded.size;
    // One batch at a time: old TVs should not project several 48-title windows concurrently when a render effect
    // reruns while the first Worker reply is still pending.
    if (this.#pending.size) return [];
    const selected: Array<TitleRef & { type: 'tv' }> = [];
    for (const title of titles) {
      if (title.type !== 'tv') continue;
      const identity = key(title);
      if (
        (loadedSize > 0 && loaded.has(identity)) ||
        this.#pending.has(identity) ||
        this.#failed.has(identity)
      )
        continue;
      this.#pending.add(identity);
      selected.push({ type: 'tv', id: title.id });
      if (selected.length === LIBRARY_SERVICE_WIRE_LIMITS.historyDetailTitles) break;
    }
    return selected;
  }

  resolved(titles: readonly TitleRef[]): void {
    for (const title of titles) this.#pending.delete(key(title));
  }

  failed(titles: readonly TitleRef[]): void {
    for (const title of titles) {
      const identity = key(title);
      this.#pending.delete(identity);
      this.#failed.add(identity);
    }
  }

  reset(): void {
    this.#pending.clear();
    this.#failed.clear();
  }
}
