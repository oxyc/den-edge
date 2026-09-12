// Stream availability from den-scout (EPIC-den-web §F2): whether a movie has anything to play, for the fade the TV
// gives a poster with nothing behind it. Asked a page of posters at a time. Scout answers from its verdicts at once
// and checks the rest behind the reply, so an unknown is asked again a little later — and never fades.
//
// Scout wants IMDb ids, so each movie's is looked up at TMDB first, as the TV's probes do. Series aren't asked: they
// need per-episode resolution. The web fades but never hides; hiding on scout's word is for a TV whose only stream
// addon is scout.

import { SvelteMap } from 'svelte/reactivity';
import type { Title } from './library';
import type { Addon } from './scout';
import { fetchImdbId } from './tmdb';
import { tmdbFetch } from './tmdbCache';

type Verdict = 'available' | 'unavailable' | 'unknown';

/** Posters that mount together go in one request. */
const GATHER_MS = 50;
/** Scout's cap on ids per request. */
const MAX_IDS = 100;
/** TMDB lookups at once. */
const LOOKUPS = 6;
/** How long before asking again about a movie scout was still checking, and how many times. */
export const RETRY_MS = 10_000;
const RETRIES = 3;
/** How long a verdict from an earlier visit fades a poster before scout has been asked again. */
export const KEPT_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'den.availability';

export class Availability {
  /** By TMDB movie id. `unknown` here is final: no IMDb id, or scout never could tell. */
  private readonly verdicts = new SvelteMap<number, Verdict>();
  /** The movies scout answered for this visit; the rest of `verdicts` came from an earlier one and is asked again. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request bookkeeping; only verdicts are UI state.
  private readonly settled = new Set<number>();
  /** When each verdict was given, so a kept one expires. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Persistence bookkeeping; only verdicts are UI state.
  private readonly givenAt = new Map<number, number>();
  /** A movie's IMDb id, or null when TMDB has none. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Lookup cache; only verdicts are UI state.
  private readonly imdbIds = new Map<number, string | null>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Request scheduling must not subscribe the components that enqueue titles.
  private readonly wanted = new Set<number>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Retry bookkeeping; only verdict changes are observable.
  private readonly tries = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scout: { base: string; tmdbKey: string; fetch: typeof fetch } | null = null;

  /**
   * TMDB's answers come from this browser's cache; scout's pass straight through it. The last day's verdicts from
   * `storage` fade their posters at once, and scout is still asked, so one that changed is corrected.
   */
  constructor(
    private readonly fetchImpl: typeof fetch = tmdbFetch,
    private readonly storage: Storage | undefined = typeof localStorage === 'undefined'
      ? undefined
      : localStorage,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const kept = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as Record<
        string,
        [Verdict, number]
      >;
      for (const [id, [verdict, at]] of Object.entries(kept)) {
        if (verdict === 'unknown' || !(now() - at < KEPT_MS)) continue;
        this.verdicts.set(Number(id), verdict);
        this.givenAt.set(Number(id), at);
      }
    } catch {
      // Unreadable or refused storage: this visit starts without them.
    }
  }

  /**
   * Ask this scout from now on — the library's (`findAddon`), or nobody when it has none — through `fetchImpl`, which
   * carries the Access token where scout's public name needs it.
   */
  connect(scout: Addon | null, tmdbKey: string, fetchImpl: typeof fetch = this.fetchImpl): void {
    const previous = this.scout?.base;
    this.scout = scout && tmdbKey ? { base: scout.base, tmdbKey, fetch: fetchImpl } : null;
    if (this.scout && previous !== undefined && this.scout.base !== previous) {
      this.verdicts.clear();
      this.settled.clear();
      this.tries.clear();
    }
    this.gather();
  }

  /** A poster is showing: its movie is asked about along with the others showing now. */
  want(title: Pick<Title, 'type' | 'id' | 'imdbId'>): void {
    if (title.type !== 'movie' || this.settled.has(title.id) || this.wanted.has(title.id)) return;
    // A title named by TMDB's details or an atlas catalog already knows its IMDb id: no lookup for it.
    if (title.imdbId) this.imdbIds.set(title.id, title.imdbId);
    this.wanted.add(title.id);
    this.gather();
  }

  /** Whether scout said this movie has nothing to play. */
  unavailable(title: Pick<Title, 'type' | 'id'>): boolean {
    return title.type === 'movie' && this.verdicts.get(title.id) === 'unavailable';
  }

  private gather(): void {
    if (!this.scout || this.timer || this.wanted.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ask();
    }, GATHER_MS);
  }

  private async ask(): Promise<void> {
    const scout = this.scout;
    if (!scout) return;
    const ids = [...this.wanted].slice(0, MAX_IDS);
    for (const id of ids) this.wanted.delete(id);

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local request accumulator, published through verdicts after the response.
    const byImdb = new Map<string, number>();
    const again: number[] = [];
    await each(ids, LOOKUPS, async (id) => {
      const imdb = await this.imdbId(id, scout.tmdbKey);
      if (imdb === undefined) again.push(id);
      else if (imdb === null) this.settle(id, 'unknown');
      else byImdb.set(imdb, id);
    });

    let answer: Record<string, Verdict> = {};
    if (byImdb.size > 0) {
      try {
        const res = await scout.fetch(`${scout.base}/availability`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [...byImdb.keys()] }),
        });
        if (res.ok)
          answer =
            ((await res.json()) as { availability?: Record<string, Verdict> }).availability ?? {};
      } catch {
        // Out of reach: every movie stays unknown, and is asked again.
      }
    }
    for (const [imdb, id] of byImdb) {
      const verdict = answer[imdb] ?? 'unknown';
      if (verdict === 'unknown') again.push(id);
      else this.settle(id, verdict);
    }
    this.keep();
    this.later(again);
    this.gather();
  }

  private settle(id: number, verdict: Verdict): void {
    this.verdicts.set(id, verdict);
    this.settled.add(id);
    this.givenAt.set(id, this.now());
  }

  /** Scout's verdicts, for the next visit's posters. Unknowns aren't kept: they are asked again anyway. */
  private keep(): void {
    const kept: Record<string, [Verdict, number]> = {};
    for (const [id, verdict] of this.verdicts) {
      const at = this.givenAt.get(id);
      if (verdict !== 'unknown' && at !== undefined) kept[id] = [verdict, at];
    }
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
      // Refused storage: the verdicts are this visit's.
    }
  }

  /** Ask again after scout has had time to check — until the tries run out, when unknown is the answer. */
  private later(ids: number[]): void {
    const retry = ids.filter((id) => {
      const tries = (this.tries.get(id) ?? 0) + 1;
      this.tries.set(id, tries);
      if (tries > RETRIES) this.settle(id, 'unknown');
      return tries <= RETRIES;
    });
    if (retry.length === 0) return;
    setTimeout(() => {
      for (const id of retry) this.wanted.add(id);
      this.gather();
    }, RETRY_MS);
  }

  private async imdbId(id: number, key: string): Promise<string | null | undefined> {
    if (this.imdbIds.has(id)) return this.imdbIds.get(id);
    const imdb = await fetchImdbId({ type: 'movie', id }, key, this.fetchImpl);
    if (imdb !== undefined) this.imdbIds.set(id, imdb);
    return imdb;
  }
}

async function each<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

export const availability = new Availability();
