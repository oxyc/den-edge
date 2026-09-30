// Shared TMDB lookups for provider viewing-history imports. A whole history is hundreds of requests, so throttled
// answers are waited out and retried rather than misread as "not found".

import { parseSeason } from './detail';
import { retryAfterMs } from './retryAfter';
import { seriesShape } from './tmdb';
import { tmdbFetch } from './tmdbCache';
import type { ViewingLookups, ViewingSearchHit } from './viewingImport';

const TMDB = 'https://api.themoviedb.org/3';
const TRIES = 8;
const IN_FLIGHT = 16;
type Json = Record<string, unknown>;

/**
 * `paused` receives the wait when den-edge's allowance is spent, then zero once requests can continue. Imports share
 * one pause and concurrency gate so a refusal cannot fan out across every title in the file.
 */
export function viewingImportLookups(
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
  paused?: (ms: number) => void,
): ViewingLookups {
  let running = 0;
  const waiting: (() => void)[] = [];
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
        const response = await limited(url.toString());
        if (response.ok) return (await response.json()) as Json;
        if (response.status !== 429 && response.status < 500) return null;
        if (response.status === 429) {
          const wait = retryAfterMs(response, 10_000);
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

  const hits = (body: Json | null, only?: 'movie' | 'tv'): ViewingSearchHit[] =>
    (Array.isArray(body?.results) ? (body.results as Json[]) : []).flatMap(
      (result): ViewingSearchHit[] => {
        const type = only ?? result.media_type;
        if ((type !== 'movie' && type !== 'tv') || typeof result.id !== 'number') return [];
        const name = type === 'movie' ? result.title : result.name;
        const original = type === 'movie' ? result.original_title : result.original_name;
        const date = type === 'movie' ? result.release_date : result.first_air_date;
        const year = typeof date === 'string' ? Number(date.slice(0, 4)) : NaN;
        if (typeof name !== 'string') return [];
        return [
          {
            type,
            id: result.id,
            name,
            ...(typeof original === 'string' ? { originalName: original } : {}),
            ...(year > 0 ? { year } : {}),
          },
        ];
      },
    );

  return {
    searchMulti: async (query) =>
      hits(await get('/search/multi', { query, include_adult: 'false' })),
    searchTv: async (query) => hits(await get('/search/tv', { query }), 'tv'),
    searchMovie: async (query, page) =>
      hits(
        await get('/search/movie', { query, page: String(page), include_adult: 'false' }),
        'movie',
      ),
    show: async (id) => {
      const body = await get(`/tv/${id}`);
      const shape = body && seriesShape(body);
      if (!shape) return null;
      const seasons = Array.isArray(body.seasons) ? (body.seasons as Json[]) : [];
      const seasonNames = new Map<number, string>(
        seasons.flatMap((season): [number, string][] =>
          typeof season.season_number === 'number' && typeof season.name === 'string'
            ? [[season.season_number, season.name]]
            : [],
        ),
      );
      return { ...shape, seasonNames };
    },
    episodes: async (id, season) => {
      const body = await get(`/tv/${id}/season/${season}`);
      return body && parseSeason(body);
    },
    runtime: async (type, id) => {
      const body = await get(`/${type}/${id}`);
      if (!body) return null;
      if (typeof body.runtime === 'number' && body.runtime > 0) return body.runtime;
      const runtimes = body.episode_run_time;
      const typical = Array.isArray(runtimes)
        ? runtimes.find((value) => typeof value === 'number' && value > 0)
        : undefined;
      return typeof typical === 'number' ? typical : null;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
