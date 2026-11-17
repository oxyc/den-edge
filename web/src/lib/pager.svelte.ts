// A list that loads a page at a time: a browse row, or Search's Explore grid. Both ask for the next page as their
// end nears, and both hide titles after loading — a hide rule, or a shelf's primary genre — so a page can arrive
// with nothing left to show. This keeps asking while that happens, a few pages at most per go.

import { appendUniqueTitles } from './catalog';
import type { Title } from './library';

/** Keep loading while a screenful hasn't survived the hide rules — a few pages at most per go. */
const FILL = 8;
const MAX_BURST = 3;

export type PagerFailure =
  | 'Couldn’t load this page. Check that this device is online.'
  | 'TMDB is temporarily limiting requests. Some titles may be missing; try again after a short wait.'
  | 'Services unavailable'
  | 'Couldn’t load';

export class Pager {
  /** Every title loaded so far, before the caller's hide rules. */
  titles = $state.raw<Title[]>([]);
  /** The source has run out, failed, or been given up on. */
  done = $state(false);
  /** The source ran out: every title there is has been loaded, not merely as many as it was worth asking for. */
  exhausted = $state(false);
  /** Pages loaded so far; 0 until the first one lands. */
  page = $state(0);
  /** The current Pager generation's failed `page + 1`, with only a presentation-safe reason. */
  failure = $state<PagerFailure | null>(null);
  #loading = false;
  readonly #lifetime = new AbortController();
  readonly #load: (page: number, signal?: AbortSignal) => Promise<Title[]>;
  readonly #admitted: (title: Title) => boolean;

  /** `admitted` is read on every call, so it may close over props that change. */
  constructor(
    load: (page: number, signal?: AbortSignal) => Promise<Title[]>,
    admitted: (title: Title) => boolean,
  ) {
    this.#load = load;
    this.#admitted = admitted;
  }

  async more() {
    const { signal } = this.#lifetime;
    if (this.#loading || this.done || signal.aborted) return;
    this.#loading = true;
    try {
      for (let burst = 0; burst < MAX_BURST && !this.done; burst++) {
        try {
          const next = await this.#load(this.page + 1, signal);
          // A provider may ignore cancellation. Disposal still owns every observable mutation after the await.
          if (signal.aborted) break;
          this.page++;
          this.titles = appendUniqueTitles(this.titles, next);
          if (next.length === 0) this.done = this.exhausted = true;
        } catch (error) {
          if (signal.aborted) break;
          // Keep raw provider/transport details out of presentation and ordinary device logs.
          const code = (error as { failure?: { code?: string } } | null)?.failure?.code;
          this.failure =
            globalThis.navigator?.onLine === false
              ? 'Couldn’t load this page. Check that this device is online.'
              : code === 'rate-limited'
                ? 'TMDB is temporarily limiting requests. Some titles may be missing; try again after a short wait.'
                : ['unavailable', 'not-ready', 'internal'].includes(code as string)
                  ? 'Services unavailable'
                  : 'Couldn’t load';
          this.done = true;
          break;
        }
        if (this.titles.filter(this.#admitted).length >= FILL * this.page) break;
      }
      // With no admitted card the tail marker never moves, so IntersectionObserver cannot trigger another
      // burst. Resolve the list after the same bounded three-page search as native instead of leaving skeletons
      // on screen forever.
      if (!signal.aborted && !this.titles.some(this.#admitted)) this.done = true;
    } finally {
      this.#loading = false;
    }
  }

  /** Ask again for the page that failed, and carry on from there. */
  retry(): Promise<void> {
    if (!this.failure || this.#loading || this.#lifetime.signal.aborted) return Promise.resolve();
    this.failure = null;
    this.done = false;
    return this.more();
  }

  /** Permanently release this list and stop the page request it owns. Late providers are ignored. */
  dispose(): void {
    this.#lifetime.abort();
  }
}
