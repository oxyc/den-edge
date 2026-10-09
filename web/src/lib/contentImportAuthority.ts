// Worker-private TMDB resolver for viewing-history imports. Import matching can fan out into hundreds of adaptive
// searches, translations and episode reads, so the authority owns one concurrency/rate-limit gate for the whole
// Worker session. The page sees only semantic lookup results.

import { parseSeason } from './detail';
import { ContentServiceFault } from './contentServiceCore';
import type {
  ContentImportLookup,
  ContentImportLookupResult,
  ContentImportSearchHit,
} from './contentServiceProtocol';
import { retryAfterMs } from './retryAfter';
import { seriesShape } from './tmdb';
import { tmdbFetch, tmdbJson } from './tmdbCache';

const TMDB = 'https://api.themoviedb.org/3';
const TRIES = 8;
const IN_FLIGHT = 16;
type Json = Record<string, unknown>;

const abortError = () => new DOMException('content request was cancelled', 'AbortError');

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const hits = (body: Json | null, only?: 'movie' | 'tv'): ContentImportSearchHit[] =>
  (Array.isArray(body?.results) ? (body.results as Json[]) : []).flatMap(
    (result): ContentImportSearchHit[] => {
      const type = only ?? result.media_type;
      if ((type !== 'movie' && type !== 'tv') || typeof result.id !== 'number') return [];
      const name = type === 'movie' ? result.title : result.name;
      const original = type === 'movie' ? result.original_title : result.original_name;
      const date = type === 'movie' ? result.release_date : result.first_air_date;
      const year = typeof date === 'string' ? Number(date.slice(0, 4)) : NaN;
      return typeof name === 'string'
        ? [
            {
              type,
              id: result.id,
              name,
              ...(typeof original === 'string' ? { originalName: original } : {}),
              ...(year > 0 ? { year } : {}),
            },
          ]
        : [];
    },
  );

interface Waiter {
  signal: AbortSignal;
  grant(): void;
  cancel(): void;
}

export class ContentImportAuthority {
  #running = 0;
  #pausedUntil = 0;
  readonly #waiting: Waiter[] = [];
  readonly #translations = new Map<string, Json>();

  constructor(
    private readonly key: () => string,
    private readonly fetchImpl: typeof fetch = tmdbFetch,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(
    lookups: readonly ContentImportLookup[],
    signal: AbortSignal,
  ): Promise<ContentImportLookupResult[]> {
    return Promise.all(lookups.map((lookup) => this.#resolveOne(lookup, signal)));
  }

  async #resolveOne(
    lookup: ContentImportLookup,
    signal: AbortSignal,
  ): Promise<ContentImportLookupResult> {
    if (lookup.kind === 'search') {
      const path = lookup.media ? `/search/${lookup.media}` : '/search/multi';
      const body = await this.#get(
        path,
        {
          query: lookup.query,
          include_adult: 'false',
          ...(lookup.page ? { page: String(lookup.page) } : {}),
        },
        signal,
      );
      return {
        id: lookup.id,
        value: body ? { kind: 'search', hits: hits(body, lookup.media) } : { kind: 'missing' },
      };
    }
    if (lookup.kind === 'translations') {
      const cacheKey = `${lookup.title.type}:${lookup.title.id}`;
      const body =
        this.#translations.get(cacheKey) ??
        (await this.#get(`/${lookup.title.type}/${lookup.title.id}/translations`, {}, signal));
      if (!body) return { id: lookup.id, value: { kind: 'missing' } };
      this.#translations.set(cacheKey, body);
      const field =
        lookup.field === 'overview' ? 'overview' : lookup.title.type === 'movie' ? 'title' : 'name';
      const translations = Array.isArray(body.translations) ? (body.translations as Json[]) : [];
      const values = [
        ...new Set(
          translations.flatMap((translation): string[] => {
            const data = object(translation.data);
            const value = data?.[field];
            return typeof value === 'string' && value.trim() ? [value] : [];
          }),
        ),
      ];
      return { id: lookup.id, value: { kind: 'translations', values } };
    }
    if (lookup.kind === 'series-shape') {
      const body = await this.#get(`/tv/${lookup.title.id}`, {}, signal);
      const shape = body && seriesShape(body);
      if (!shape) return { id: lookup.id, value: { kind: 'missing' } };
      const names = new Map<number, string>(
        (Array.isArray(body.seasons) ? (body.seasons as Json[]) : []).flatMap(
          (season): [number, string][] =>
            typeof season.season_number === 'number' && typeof season.name === 'string'
              ? [[season.season_number, season.name]]
              : [],
        ),
      );
      return {
        id: lookup.id,
        value: {
          kind: 'series-shape',
          seasons: [...shape.counts].map(([season, episodes]) => ({
            season,
            episodes,
            ...(names.has(season) ? { name: names.get(season) } : {}),
          })),
          ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
        },
      };
    }
    if (lookup.kind === 'episodes') {
      const body = await this.#get(`/tv/${lookup.title.id}/season/${lookup.season}`, {}, signal);
      return {
        id: lookup.id,
        value: body ? { kind: 'episodes', episodes: parseSeason(body) } : { kind: 'missing' },
      };
    }
    const body = await this.#get(`/${lookup.title.type}/${lookup.title.id}`, {}, signal);
    if (!body) return { id: lookup.id, value: { kind: 'missing' } };
    const direct = body.runtime;
    const typical = Array.isArray(body.episode_run_time)
      ? body.episode_run_time.find((value) => typeof value === 'number' && value > 0)
      : undefined;
    const minutes =
      typeof direct === 'number' && direct > 0
        ? direct
        : typeof typical === 'number'
          ? typical
          : null;
    return { id: lookup.id, value: { kind: 'runtime', minutes } };
  }

  async #get(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Json | null> {
    const url = new URL(TMDB + path);
    for (const [name, value] of Object.entries({ ...params, api_key: this.key() }))
      url.searchParams.set(name, value);
    for (let attempt = 0; attempt < TRIES; attempt++) {
      if (signal.aborted) throw abortError();
      try {
        const response = await this.#limited(url.toString(), signal);
        if (response.ok) {
          const body = object(await tmdbJson(response));
          if (body) return body;
          throw this.#fault('TMDB returned an invalid import answer', false);
        }
        if (response.status === 404) return null;
        if (response.status === 401 || response.status === 403)
          throw this.#fault('TMDB refused the import lookup', false, 'refused');
        if (response.status !== 429 && response.status < 500) return null;
        if (response.status === 429 || response.headers.has('retry-after')) {
          const wait = retryAfterMs(response, 10_000, this.now);
          this.#pausedUntil = Math.max(this.#pausedUntil, this.now() + wait);
        }
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError'))
          throw abortError();
        if (error instanceof ContentServiceFault) throw error;
      }
      if (attempt + 1 < TRIES) await this.#delay(2_000 * (attempt + 1), signal);
    }
    throw this.#fault('TMDB import lookups are temporarily unavailable', true);
  }

  async #limited(url: string, signal: AbortSignal): Promise<Response> {
    for (;;) {
      const rest = this.#pausedUntil - this.now();
      if (rest > 0) await this.#delay(rest, signal);
      await this.#acquire(signal);
      // A request ahead of this one may have established a shared pause while this one waited for a slot.
      if (this.#pausedUntil <= this.now()) break;
      this.#release();
    }
    try {
      return await this.fetchImpl(url, { signal });
    } finally {
      this.#release();
    }
  }

  async #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    if (this.#running < IN_FLIGHT) {
      this.#running++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', waiter.cancel);
          resolve();
        },
        cancel: () => {
          const at = this.#waiting.indexOf(waiter);
          if (at >= 0) this.#waiting.splice(at, 1);
          reject(abortError());
        },
      };
      this.#waiting.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }

  #release(): void {
    let next = this.#waiting.shift();
    while (next?.signal.aborted) next = this.#waiting.shift();
    if (next) next.grant();
    else this.#running--;
  }

  #delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        reject(abortError());
      };
      function done() {
        signal.removeEventListener('abort', cancel);
        resolve();
      }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  #fault(message: string, retryable: boolean, code: 'refused' | 'unavailable' = 'unavailable') {
    return new ContentServiceFault({ code, message, retryable, provider: 'tmdb' });
  }
}
