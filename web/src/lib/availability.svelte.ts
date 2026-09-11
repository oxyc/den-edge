// Stream availability from den-scout (EPIC-den-web §F2): whether a movie has anything to play, for the fade the TV
// gives a poster with nothing behind it. Asked a page of posters at a time. Scout answers from its verdicts at once
// and checks the rest behind the reply, so an unknown is asked again a little later — and never fades.
//
// Scout wants IMDb ids, so each movie's is looked up at TMDB first, as the TV's probes do. Series aren't asked: they
// need per-episode resolution. The web fades but never hides; hiding on scout's word is for a TV whose only stream
// addon is scout.

import { SvelteMap } from 'svelte/reactivity';
import type { Title } from './library';
import type { Scout } from './scout';
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

export class Availability {
  /** By TMDB movie id. `unknown` here is final: no IMDb id, or scout never could tell. */
  private readonly verdicts = new SvelteMap<number, Verdict>();
  /** A movie's IMDb id, or null when TMDB has none. */
  private readonly imdbIds = new Map<number, string | null>();
  private readonly wanted = new Set<number>();
  private readonly tries = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scout: { config: string; tmdbKey: string } | null = null;

  /** TMDB's answers come from this browser's cache; scout's pass straight through it. */
  constructor(private readonly fetchImpl: typeof fetch = tmdbFetch) {}

  /** Ask this scout from now on — the library's (`findScout`), or nobody when it has none. */
  connect(scout: Scout | null, tmdbKey: string): void {
    const previous = this.scout?.config;
    this.scout = scout && tmdbKey ? { config: scout.config, tmdbKey } : null;
    if (this.scout && this.scout.config !== previous) {
      this.verdicts.clear();
      this.tries.clear();
    }
    this.gather();
  }

  /** A poster is showing: its movie is asked about along with the others showing now. */
  want(title: Pick<Title, 'type' | 'id'>): void {
    if (title.type !== 'movie' || this.verdicts.has(title.id) || this.wanted.has(title.id)) return;
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

    const byImdb = new Map<string, number>();
    const again: number[] = [];
    await each(ids, LOOKUPS, async (id) => {
      const imdb = await this.imdbId(id, scout.tmdbKey);
      if (imdb === undefined) again.push(id);
      else if (imdb === null) this.verdicts.set(id, 'unknown');
      else byImdb.set(imdb, id);
    });

    let answer: Record<string, Verdict> = {};
    if (byImdb.size > 0) {
      try {
        const res = await this.fetchImpl(`/scout/${scout.config}/availability`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [...byImdb.keys()] }),
        });
        if (res.ok) answer = ((await res.json()) as { availability?: Record<string, Verdict> }).availability ?? {};
      } catch {
        // Out of reach: every movie stays unknown, and is asked again.
      }
    }
    for (const [imdb, id] of byImdb) {
      const verdict = answer[imdb] ?? 'unknown';
      if (verdict === 'unknown') again.push(id);
      else this.verdicts.set(id, verdict);
    }
    this.later(again);
    this.gather();
  }

  /** Ask again after scout has had time to check — until the tries run out, when unknown is the answer. */
  private later(ids: number[]): void {
    const retry = ids.filter((id) => {
      const tries = (this.tries.get(id) ?? 0) + 1;
      this.tries.set(id, tries);
      if (tries > RETRIES) this.verdicts.set(id, 'unknown');
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
