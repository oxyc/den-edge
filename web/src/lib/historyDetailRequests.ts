import { titleKey } from './library';
import { LIBRARY_SERVICE_WIRE_LIMITS, type TitleRef } from './libraryServiceProtocol';

/**
 * One History snapshot's bounded detail-query state. A failed title is latched until the snapshot changes: an
 * unavailable Worker must not turn a reactive render effect into an unbounded request loop.
 */
export class HistoryDetailRequests {
  #pending = false;
  readonly #failed = new Set<number>();

  take(
    titles: readonly TitleRef[],
    loaded: ReadonlyMap<string, unknown>,
  ): Array<TitleRef & { type: 'tv' }> {
    // Read reactive loaded state on every call, including while a request is pending. Otherwise a Svelte effect that
    // reruns during the request can drop its SvelteMap dependency and never run again when this batch is stored.
    const loadedSize = loaded.size;
    // One batch at a time: old TVs should not project several 48-title windows concurrently when a render effect
    // reruns while the first Worker reply is still pending.
    if (this.#pending) return [];
    const selected: Array<TitleRef & { type: 'tv' }> = [];
    for (const title of titles) {
      if (title.type !== 'tv') continue;
      if ((loadedSize > 0 && loaded.has(titleKey(title))) || this.#failed.has(title.id)) continue;
      selected.push({ type: 'tv', id: title.id });
      if (selected.length === LIBRARY_SERVICE_WIRE_LIMITS.historyDetailTitles) break;
    }
    this.#pending = selected.length > 0;
    return selected;
  }

  settled(failed: readonly TitleRef[] = []): void {
    this.#pending = false;
    for (const title of failed) this.#failed.add(title.id);
  }

  reset(): void {
    this.#pending = false;
    this.#failed.clear();
  }
}
