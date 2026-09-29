// The TMDB lookups a Netflix import matches with (`netflixImport.Lookups`), through the page's cached TMDB fetch.
// A whole viewing history is hundreds of lookups, past den-edge's per-minute allowance, so a throttled answer is
// waited out and asked again instead of read as "nothing found".

import { parseSeason } from './detail';
import type { Lookups, SearchHit } from './netflixImport';
import { retryAfterMs } from './retryAfter';
import { seriesShape } from './tmdb';
import { tmdbFetch } from './tmdbCache';

const TMDB = 'https://api.themoviedb.org/3';
const TRIES = 8;

type Json = Record<string, unknown>;

/** Lookups in flight at once: den-edge runs 32 cold TMDB fetches together, and the page has its own to make. */
const IN_FLIGHT = 16;

/**
 * `waiting` is told when den-edge's per-minute allowance is spent and every lookup pauses until it renews (the ms
 * left), and with 0 once they carry on: a pause that says nothing reads as a frozen import.
 */
export function netflixLookups(
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
  paused?: (ms: number) => void,
): Lookups {
  let running = 0;
  const waiting: (() => void)[] = [];
  /** Until when den-edge refuses: every lookup waits it out together rather than each being refused in turn. */
  let pausedUntil = 0;
  async function limited(url: string): Promise<Response> {
    while (Date.now() < pausedUntil) await sleep(pausedUntil - Date.now());
    if (running >= IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await fetchImpl(url);
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  async function get(path: string, params: Record<string, string> = {}): Promise<Json | null> {
    const url = new URL(TMDB + path);
    for (const [name, value] of Object.entries({ ...params, api_key: key }))
      url.searchParams.set(name, value);
    for (let attempt = 0; attempt < TRIES; attempt++) {
      try {
        const res = await limited(url.toString());
        if (res.ok) return (await res.json()) as Json;
        if (res.status !== 429 && res.status < 500) return null;
        if (res.status === 429) {
          const wait = retryAfterMs(res, 10_000);
          if (Date.now() + wait > pausedUntil) {
            pausedUntil = Date.now() + wait;
            paused?.(wait);
            setTimeout(() => {
              if (Date.now() >= pausedUntil) paused?.(0);
            }, wait);
          }
          continue;
        }
        await sleep(2_000 * (attempt + 1));
      } catch {
        await sleep(2_000 * (attempt + 1));
      }
    }
    return null;
  }

  const hits = (body: Json | null, only?: 'movie' | 'tv'): SearchHit[] =>
    (Array.isArray(body?.results) ? (body.results as Json[]) : []).flatMap((r): SearchHit[] => {
      const type = only ?? r.media_type;
      if ((type !== 'movie' && type !== 'tv') || typeof r.id !== 'number') return [];
      const name = type === 'movie' ? r.title : r.name;
      const original = type === 'movie' ? r.original_title : r.original_name;
      const date = type === 'movie' ? r.release_date : r.first_air_date;
      const year = typeof date === 'string' ? Number(date.slice(0, 4)) : NaN;
      if (typeof name !== 'string') return [];
      return [
        {
          type,
          id: r.id,
          name,
          ...(typeof original === 'string' ? { originalName: original } : {}),
          ...(year > 0 ? { year } : {}),
        },
      ];
    });

  return {
    searchMulti: async (query) =>
      hits(await get('/search/multi', { query, include_adult: 'false' })),
    searchTv: async (query) => hits(await get('/search/tv', { query }), 'tv'),
    show: async (id) => {
      const body = await get(`/tv/${id}`);
      return (body && seriesShape(body)) ?? null;
    },
    episodes: async (id, season) => {
      const body = await get(`/tv/${id}/season/${season}`);
      return body && parseSeason(body);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
