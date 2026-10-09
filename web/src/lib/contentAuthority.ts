/**
 * Worker-private access to credentialed title metadata.
 *
 * The page-facing protocol should depend on `ContentReader`, never on provider URLs, response shapes, API keys or
 * fetch implementations. This authority is deliberately independent of the Worker transport so the protocol can
 * expose whichever subset of these domain operations it needs without making provider concerns part of the UI.
 */

import { parseWarnings, type Warning } from './contentWarnings';
import { ContentServiceFault, type ContentServiceAuthority } from './contentServiceCore';
import type {
  ContentProvider,
  ContentRequest,
  ContentResult as ServiceContentResult,
  OptionalContent,
} from './contentServiceProtocol';
import { parseDetail, parseSeason, type Episode, type TitleDetail } from './detail';
import { parseRatings, type Ratings } from './detailPresentation';
import { parseIconicStudios, type IconicStudio } from './iconicStudios';
import type { MediaType } from './library';
import { relayFetch } from './relayFetch';
import { retryAfterMs } from './retryAfter';
import { seriesShape, toTitle, type Details } from './tmdb';
import { parseTitleFacts, type TitleFacts } from './titleFacts';
import { TMDB_PROXY_KEY, tmdbFetch, tmdbJson, tmdbMissing } from './tmdbCache';

const TMDB = 'https://api.themoviedb.org/3';

export interface ContentRef {
  type: MediaType;
  id: number;
}

export type ContentUnavailableReason =
  'network' | 'rate-limited' | 'unauthorized' | 'upstream' | 'invalid-answer';

/** Absence is durable provider knowledge; an unavailable answer is safe to retry. */
export type ProviderResult<T> =
  | { kind: 'found'; value: T }
  | { kind: 'missing' }
  | { kind: 'not-configured' }
  | {
      kind: 'unavailable';
      reason: ContentUnavailableReason;
      status?: number;
      retryAfterMs?: number;
    };

export interface ContentIdentifiers {
  /** `null` means TMDB has no IMDb id; it is not a provider failure. */
  imdbId: string | null;
}

export interface ContentWarningSet {
  id: number;
  warnings: Warning[];
}

/** Ratings and warnings fail independently and should never hold one another off the page. */
export interface ContentExtras {
  ratings: ProviderResult<Ratings>;
  warnings: ProviderResult<ContentWarningSet>;
}

/** The only provider surface the Worker protocol needs to know. */
export interface ContentReader {
  title(ref: ContentRef): Promise<ProviderResult<Details>>;
  detail(ref: ContentRef, region?: string): Promise<ProviderResult<TitleDetail>>;
  season(seriesId: number, season: number): Promise<ProviderResult<Episode[]>>;
  identifiers(ref: ContentRef): Promise<ProviderResult<ContentIdentifiers>>;
  extras(imdbId: string, warningCategories?: readonly string[]): Promise<ContentExtras>;
}

/**
 * Read at request time so a key saved while the Worker lives is used by the next question. The values never cross
 * `ContentReader`; the protocol receives only normalized results.
 */
export interface ContentCredentialSource {
  /** Register any relay-only capability before the first provider request; it never exposes that capability. */
  ready?(): Promise<void>;
  tmdb(): string | undefined;
  omdb(): string | undefined;
  contentWarnings(): string | undefined;
  atlas?(): string | undefined;
}

/** Mutable only inside the Worker: an anonymous session starts keyless, then a library authority may bind keys. */
export class WorkerContentCredentials implements ContentCredentialSource {
  #source?: ContentCredentialSource;

  bind(source: ContentCredentialSource): () => void {
    this.#source = source;
    return () => {
      if (this.#source === source) this.#source = undefined;
    };
  }

  tmdb(): string | undefined {
    return this.#source?.tmdb();
  }

  omdb(): string | undefined {
    return this.#source?.omdb();
  }

  contentWarnings(): string | undefined {
    return this.#source?.contentWarnings();
  }

  atlas(): string | undefined {
    return this.#source?.atlas?.() ?? '/atlas';
  }

  ready(): Promise<void> {
    return this.#source?.ready?.() ?? Promise.resolve();
  }
}

export interface ContentAuthorityOptions {
  tmdbFetch?: typeof fetch;
  providerFetch?: typeof fetch;
  now?: () => number;
}

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const validRef = (ref: ContentRef): boolean =>
  (ref.type === 'movie' || ref.type === 'tv') && Number.isSafeInteger(ref.id) && ref.id > 0;

const validSeason = (seriesId: number, season: number): boolean =>
  Number.isSafeInteger(seriesId) && seriesId > 0 && Number.isSafeInteger(season) && season >= 0;

function unavailable(
  reason: ContentUnavailableReason,
  response?: Response,
  now: () => number = Date.now,
): Extract<ProviderResult<never>, { kind: 'unavailable' }> {
  const status = response?.status;
  const retryAfter =
    response && (status === 429 || status === 503)
      ? retryAfterMs(response, 60_000, now)
      : undefined;
  return {
    kind: 'unavailable',
    reason,
    ...(status ? { status } : {}),
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
  };
}

function refused(response: Response, now: () => number): ProviderResult<never> {
  if (response.status === 429 || (response.status === 503 && response.headers.has('retry-after')))
    return unavailable('rate-limited', response, now);
  if (response.status === 401 || response.status === 403)
    return unavailable('unauthorized', response, now);
  return unavailable('upstream', response, now);
}

const optionalReason = (
  reason: ContentUnavailableReason,
): Extract<OptionalContent<never>, { state: 'unavailable' }>['reason'] =>
  reason === 'unauthorized' ? 'refused' : reason === 'upstream' ? undefined : reason;

function optional<T>(result: ProviderResult<T>, provider: ContentProvider): OptionalContent<T> {
  switch (result.kind) {
    case 'found':
      return { state: 'ready', value: result.value };
    case 'missing':
      return { state: 'absent' };
    case 'not-configured':
      return { state: 'not-configured' };
    case 'unavailable':
      return {
        state: 'unavailable',
        provider,
        ...(optionalReason(result.reason) ? { reason: optionalReason(result.reason) } : {}),
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      };
  }
}

function tmdbUrl(path: string, key: string, params: Record<string, string> = {}): string {
  const url = new URL(TMDB + path);
  for (const [name, value] of Object.entries({ ...params, api_key: key }))
    url.searchParams.set(name, value);
  return url.toString();
}

/** A single Worker-session owner for provider access and exact in-flight coalescing. */
export class ContentAuthority implements ContentReader, ContentServiceAuthority {
  readonly #tmdbFetch: typeof fetch;
  readonly #providerFetch: typeof fetch;
  readonly #now: () => number;
  readonly #flights = new Map<string, Promise<unknown>>();

  constructor(
    private readonly credentials: ContentCredentialSource,
    options: ContentAuthorityOptions = {},
  ) {
    this.#tmdbFetch = options.tmdbFetch ?? tmdbFetch;
    this.#providerFetch = options.providerFetch ?? relayFetch;
    this.#now = options.now ?? Date.now;
  }

  async query(request: ContentRequest, signal: AbortSignal): Promise<ServiceContentResult> {
    await this.#wait(this.credentials.ready?.() ?? Promise.resolve(), signal);
    switch (request.kind) {
      case 'titles': {
        const titles: Details['title'][] = [];
        const retryable: ContentRef[] = [];
        let next = 0;
        const read = async () => {
          for (let ref = request.titles[next++]; ref; ref = request.titles[next++]) {
            const result = await this.#wait(this.title(ref), signal);
            if (result.kind === 'found') titles.push(result.value.title);
            else if (result.kind === 'unavailable' || result.kind === 'not-configured')
              retryable.push(ref);
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, request.titles.length) }, read));
        const order = new Map(request.titles.map((ref, index) => [`${ref.type}:${ref.id}`, index]));
        titles.sort(
          (left, right) =>
            (order.get(`${left.type}:${left.id}`) ?? 0) -
            (order.get(`${right.type}:${right.id}`) ?? 0),
        );
        retryable.sort(
          (left, right) =>
            (order.get(`${left.type}:${left.id}`) ?? 0) -
            (order.get(`${right.type}:${right.id}`) ?? 0),
        );
        return { kind: 'titles', titles, retryable };
      }
      case 'title.detail':
        return {
          kind: 'title.detail',
          detail: optional(
            await this.#wait(this.detail(request.title, request.region), signal),
            'tmdb',
          ),
        };
      case 'title.external-id': {
        const result = await this.#wait(this.identifiers(request.title), signal);
        return {
          kind: 'title.external-id',
          imdbId:
            result.kind === 'found'
              ? result.value.imdbId
                ? { state: 'ready', value: result.value.imdbId }
                : { state: 'absent' }
              : optional(result, 'tmdb'),
        };
      }
      case 'season':
        return {
          kind: 'season',
          episodes: optional(
            await this.#wait(this.season(request.title.id, request.season), signal),
            'tmdb',
          ),
        };
      case 'title.extras':
        return this.#queryExtras(request.title, request.warningCategories, signal);
      default:
        throw new ContentServiceFault({
          code: 'not-ready',
          message: `${request.kind} is not owned by ContentAuthority yet`,
          retryable: false,
        });
    }
  }

  title(ref: ContentRef): Promise<ProviderResult<Details>> {
    if (!validRef(ref)) return Promise.resolve(unavailable('invalid-answer'));
    const key = this.#tmdbKey();
    return this.#join(`title\0${ref.type}:${ref.id}\0${key}`, async () => {
      const append = ref.type === 'tv' ? 'credits,external_ids' : 'credits';
      const body = await this.#tmdb(`/${ref.type}/${ref.id}`, key, { append_to_response: append });
      if (body.kind !== 'found') return body;
      const title = toTitle(ref, body.value);
      if (!title) return unavailable('invalid-answer');
      return {
        kind: 'found',
        value: ref.type === 'tv' ? { title, shape: seriesShape(body.value) } : { title },
      };
    });
  }

  detail(ref: ContentRef, region = 'US'): Promise<ProviderResult<TitleDetail>> {
    if (!validRef(ref)) return Promise.resolve(unavailable('invalid-answer'));
    const country = /^[a-z]{2}$/i.test(region) ? region.toUpperCase() : 'US';
    const key = this.#tmdbKey();
    return this.#join(`detail\0${ref.type}:${ref.id}\0${country}\0${key}`, async () => {
      const append =
        ref.type === 'tv'
          ? 'aggregate_credits,recommendations,videos,external_ids,content_ratings,watch/providers'
          : 'credits,recommendations,videos,external_ids,release_dates,watch/providers';
      const body = await this.#tmdb(`/${ref.type}/${ref.id}`, key, { append_to_response: append });
      if (body.kind !== 'found') return body;
      const detail = parseDetail(ref, body.value, country);
      return detail ? { kind: 'found', value: detail } : unavailable('invalid-answer');
    });
  }

  season(seriesId: number, season: number): Promise<ProviderResult<Episode[]>> {
    if (!validSeason(seriesId, season)) return Promise.resolve(unavailable('invalid-answer'));
    const key = this.#tmdbKey();
    return this.#join(`season\0${seriesId}:${season}\0${key}`, async () => {
      const body = await this.#tmdb(`/tv/${seriesId}/season/${season}`, key);
      if (body.kind !== 'found') return body;
      if (!Array.isArray(body.value.episodes)) return unavailable('invalid-answer');
      return { kind: 'found', value: parseSeason(body.value) };
    });
  }

  identifiers(ref: ContentRef): Promise<ProviderResult<ContentIdentifiers>> {
    if (!validRef(ref)) return Promise.resolve(unavailable('invalid-answer'));
    const key = this.#tmdbKey();
    return this.#join(`identifiers\0${ref.type}:${ref.id}\0${key}`, async () => {
      const body = await this.#tmdb(`/${ref.type}/${ref.id}/external_ids`, key);
      if (body.kind !== 'found') return body;
      // `/external_ids` normally answers at the top level. Accept an appended-detail shape too: relay and test
      // caches may satisfy this normalized operation from a detail document that already carried the same field.
      const value = body.value.imdb_id ?? object(body.value.external_ids)?.imdb_id;
      if (value === null || value === undefined || value === '')
        return { kind: 'found', value: { imdbId: null } };
      return typeof value === 'string' && /^tt\d+$/.test(value)
        ? { kind: 'found', value: { imdbId: value } }
        : unavailable('invalid-answer');
    });
  }

  async extras(imdbId: string, warningCategories: readonly string[] = []): Promise<ContentExtras> {
    if (!/^tt\d+$/.test(imdbId))
      return { ratings: { kind: 'missing' }, warnings: { kind: 'missing' } };
    const categories = [...new Set(warningCategories.filter((value) => value.length <= 4_096))];
    const [ratings, warnings] = await Promise.all([
      this.#ratings(imdbId),
      this.#warnings(imdbId, categories),
    ]);
    return { ratings, warnings };
  }

  async #queryExtras(
    ref: ContentRef,
    warningCategories: readonly string[],
    signal: AbortSignal,
  ): Promise<ServiceContentResult> {
    const [identifiers, facts, iconicStudios] = await Promise.all([
      this.#wait(this.identifiers(ref), signal),
      this.#wait(this.#facts(ref), signal),
      this.#wait(this.#iconicStudios(ref), signal),
    ]);
    let ratings: OptionalContent<Ratings>;
    let warnings: OptionalContent<Warning[]>;
    if (identifiers.kind === 'found' && identifiers.value.imdbId) {
      const extras = await this.#wait(
        this.extras(identifiers.value.imdbId, warningCategories),
        signal,
      );
      ratings = optional(extras.ratings, 'ratings');
      const warned = optional(extras.warnings, 'warnings');
      warnings =
        warned.state === 'ready' ? { state: 'ready', value: warned.value.warnings } : warned;
    } else if (identifiers.kind === 'found' || identifiers.kind === 'missing') {
      ratings = { state: 'absent' };
      warnings = { state: 'absent' };
    } else {
      ratings = optional(identifiers, 'tmdb');
      warnings = optional(identifiers, 'tmdb');
    }
    return {
      kind: 'title.extras',
      extras: {
        title: { type: ref.type, id: ref.id },
        ratings,
        warnings,
        facts: optional(facts, 'atlas'),
        iconicStudios: optional(iconicStudios, 'atlas'),
      },
    };
  }

  #tmdbKey(): string {
    return this.credentials.tmdb()?.trim() || TMDB_PROXY_KEY;
  }

  #facts(ref: ContentRef): Promise<ProviderResult<TitleFacts>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return Promise.resolve({ kind: 'not-configured' });
    const type = ref.type === 'tv' ? 'series' : 'movie';
    return this.#join(`facts\0${ref.type}:${ref.id}\0${atlas}`, async () => {
      const response = await this.#provider(`${atlas}/index/title/${type}/${ref.id}.json`, '');
      return response.kind === 'found'
        ? { kind: 'found', value: parseTitleFacts(response.value) }
        : response;
    });
  }

  #iconicStudios(ref: ContentRef): Promise<ProviderResult<IconicStudio[]>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return Promise.resolve({ kind: 'not-configured' });
    const type = ref.type === 'tv' ? 'series' : 'movie';
    return this.#join(`studios\0${ref.type}:${ref.id}\0${atlas}`, async () => {
      const response = await this.#provider(`${atlas}/index/studios/${type}/${ref.id}.json`, '');
      return response.kind === 'found'
        ? { kind: 'found', value: parseIconicStudios(response.value) }
        : response;
    });
  }

  #ratings(imdbId: string): Promise<ProviderResult<Ratings>> {
    const key = this.credentials.omdb()?.trim() ?? '';
    return this.#join(`ratings\0${imdbId}\0${key}`, async () => {
      const response = await this.#provider(`/ratings/imdb/${encodeURIComponent(imdbId)}`, key);
      if (response.kind === 'missing' && !key) return { kind: 'not-configured' };
      if (response.kind !== 'found') return response;
      const parsed = parseRatings(response.value);
      return parsed ? { kind: 'found', value: parsed } : { kind: 'missing' };
    });
  }

  #warnings(imdbId: string, categories: string[]): Promise<ProviderResult<ContentWarningSet>> {
    const key = this.credentials.contentWarnings()?.trim() ?? '';
    const categoryKey = JSON.stringify(categories);
    return this.#join(`warnings\0${imdbId}\0${categoryKey}\0${key}`, async () => {
      const response = await this.#provider(`/warnings/imdb/${encodeURIComponent(imdbId)}`, key, {
        accept: 'application/json',
      });
      if (response.kind === 'missing' && !key) return { kind: 'not-configured' };
      if (response.kind !== 'found') return response;
      const id = Number(response.value.id);
      if (!Number.isSafeInteger(id) || id < 1) return unavailable('invalid-answer');
      return {
        kind: 'found',
        value: { id, warnings: parseWarnings(response.value, categories) },
      };
    });
  }

  async #tmdb(
    path: string,
    key: string,
    params: Record<string, string> = {},
  ): Promise<ProviderResult<Json>> {
    let response: Response;
    try {
      response = await this.#tmdbFetch(tmdbUrl(path, key, params), {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return unavailable('network');
    }
    if (!response.ok) {
      if (await tmdbMissing(response)) return { kind: 'missing' };
      return refused(response, this.#now);
    }
    try {
      const body = object(await tmdbJson(response));
      return body ? { kind: 'found', value: body } : unavailable('invalid-answer');
    } catch {
      return unavailable('invalid-answer');
    }
  }

  async #provider(
    path: string,
    key: string,
    headers: Record<string, string> = {},
  ): Promise<ProviderResult<Json>> {
    const requestHeaders = new Headers(headers);
    if (key) requestHeaders.set('x-api-key', key);
    let response: Response;
    try {
      response = await this.#providerFetch(path, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return unavailable('network');
    }
    if (response.status === 404) return { kind: 'missing' };
    if (!response.ok) return refused(response, this.#now);
    try {
      const body = object(await response.json());
      return body ? { kind: 'found', value: body } : unavailable('invalid-answer');
    } catch {
      return unavailable('invalid-answer');
    }
  }

  #join<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.#flights.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const flight = start();
    this.#flights.set(key, flight);
    void flight.finally(() => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    return flight;
  }

  #wait<T>(flight: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      void flight.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
