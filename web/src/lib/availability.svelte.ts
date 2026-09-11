// Stream availability from den-scout (EPIC-den-web §F2): whether a movie has anything to play, for the fade the TV
// gives a poster with nothing behind it. Asked a page of posters at a time. Scout answers from its verdicts at once
// and checks the rest behind the reply, so an unknown is asked again a little later — and never fades.
//
// Scout wants IMDb ids, so each movie's is looked up at TMDB first, as the TV's probes do. Series aren't asked: they
// need per-episode resolution. The web fades but never hides; hiding on scout's word is for a TV whose only stream
// addon is scout.

import { SvelteMap } from 'svelte/reactivity';
import type { Title } from './library';
import { isLanURL } from './prefs';

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
const SCOUT = 'com.den.scout';

export class Availability {
  /** By TMDB movie id. `unknown` here is final: no IMDb id, or scout never could tell. */
  private readonly verdicts = new SvelteMap<number, Verdict>();
  /** A movie's IMDb id, or null when TMDB has none. */
  private readonly imdbIds = new Map<number, string | null>();
  private readonly wanted = new Set<number>();
  private readonly tries = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scout: { config: string; tmdbKey: string } | null = null;

  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  /**
   * Find scout among the library's plugins. Its install URL names the TV's LAN address, which this page can't reach,
   * so each LAN plugin's config is tried against scout on this page's own origin (`/scout/`): the one whose manifest
   * is scout's. A public addon's URL is never sent.
   */
  async connect(plugins: string[], tmdbKey: string): Promise<void> {
    const previous = this.scout?.config;
    this.scout = null;
    if (!tmdbKey) return;
    for (const url of plugins) {
      const config = lanConfig(url);
      if (!config) continue;
      try {
        const res = await this.fetchImpl(`/scout/${config}/manifest.json`);
        if (!res.ok || ((await res.json()) as { id?: unknown }).id !== SCOUT) continue;
      } catch {
        continue;
      }
      if (config !== previous) {
        this.verdicts.clear();
        this.tries.clear();
      }
      this.scout = { config, tmdbKey };
      this.gather();
      return;
    }
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

  /** The movie's IMDb id from TMDB; null when it has none, undefined when TMDB couldn't be asked. */
  private async imdbId(id: number, key: string): Promise<string | null | undefined> {
    if (this.imdbIds.has(id)) return this.imdbIds.get(id);
    try {
      const res = await this.fetchImpl(
        `https://api.themoviedb.org/3/movie/${id}/external_ids?api_key=${encodeURIComponent(key)}`,
      );
      if (!res.ok) return undefined;
      const found = ((await res.json()) as { imdb_id?: unknown }).imdb_id;
      const imdb = typeof found === 'string' && /^tt\d+$/.test(found) ? found : null;
      this.imdbIds.set(id, imdb);
      return imdb;
    } catch {
      return undefined;
    }
  }
}

/** The config segment of a LAN addon's `…/<config>/manifest.json` URL. */
function lanConfig(url: string): string | null {
  if (!isLanURL(url)) return null;
  const [config, file, ...rest] = new URL(url).pathname.split('/').filter(Boolean);
  return config && file === 'manifest.json' && rest.length === 0 && /^[\w.~%-]+$/.test(config) ? config : null;
}

async function each<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

export const availability = new Availability();
