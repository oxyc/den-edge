// A list that loads a page at a time: a browse row, or Search's Explore grid. Both ask for the next page as their
// end nears, and both hide titles after loading — a hide rule, or a shelf's primary genre — so a page can arrive
// with nothing left to show. This keeps asking while that happens, a few pages at most per go.

import { appendUniqueTitles } from './catalog';
import type { Title } from './library';

/** Keep loading while a screenful hasn't survived the hide rules — a few pages at most per go. */
const FILL = 8;
const MAX_BURST = 3;

export class Pager {
  /** Every title loaded so far, before the caller's hide rules. */
  titles = $state.raw<Title[]>([]);
  /** The source has run out, failed, or been given up on. */
  done = $state(false);
  /** The source ran out: every title there is has been loaded, not merely as many as it was worth asking for. */
  exhausted = $state(false);
  /** Pages loaded so far; 0 until the first one lands. */
  page = $state(0);
  /** The last page asked for failed: the list says so and offers `retry`, rather than simply ending. */
  failed = $state(false);
  #loading = false;
  #disposed = false;
  #request?: AbortController;
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
    if (this.#loading || this.done || this.#disposed) return;
    this.#loading = true;
    const request = new AbortController();
    const { signal } = request;
    this.#request = request;
    try {
      for (let burst = 0; burst < MAX_BURST && !this.done; burst++) {
        try {
          const next = await this.#load(this.page + 1, signal);
          // A provider may ignore cancellation. Disposal still owns every observable mutation after the await.
          if (this.#disposed || signal.aborted) break;
          this.page++;
          this.titles = appendUniqueTitles(this.titles, next);
          if (next.length === 0) this.done = this.exhausted = true;
        } catch (error) {
          if (this.#disposed || signal.aborted) break;
          // The row stops where its source failed, until `retry`; what failed is said, not swallowed.
          console.warn('pager: page', this.page + 1, 'failed', error);
          this.failed = this.done = true;
          break;
        }
        if (this.titles.filter(this.#admitted).length >= FILL * this.page) break;
      }
      // With no admitted card the tail marker never moves, so IntersectionObserver cannot trigger another
      // burst. Resolve the list after the same bounded three-page search as native instead of leaving skeletons
      // on screen forever.
      if (!this.#disposed && !this.titles.some(this.#admitted)) this.done = true;
    } finally {
      if (this.#request === request) this.#request = undefined;
      this.#loading = false;
    }
  }

  /** Ask again for the page that failed, and carry on from there. */
  retry(): Promise<void> {
    if (!this.failed || this.#loading || this.#disposed) return Promise.resolve();
    this.failed = this.done = false;
    return this.more();
  }

  /** Permanently release this list and stop the page request it owns. Late providers are ignored. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#request?.abort();
  }
}
