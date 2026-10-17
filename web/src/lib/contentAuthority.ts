/**
 * Worker-private access to credentialed title metadata.
 *
 * The page-facing protocol should depend on `ContentReader`, never on provider URLs, response shapes, API keys or
 * fetch implementations. This authority is deliberately independent of the Worker transport so the protocol can
 * expose whichever subset of these domain operations it needs without making provider concerns part of the UI.
 */

import { parseWarnings, type Warning } from './contentWarnings';
import { titlesOf } from './atlasRows';
import { ContentServiceFault, type ContentServiceAuthority } from './contentServiceCore';
import {
  ageAllowed,
  atlasPolicyIdentity,
  failsClosed,
  isAgeRestricted,
  isRestricted,
  policedAtlasFetch,
  policyKey,
} from './contentPolicy';
import type {
  ContentPolicy,
  ContentProvider,
  ContentRequest,
  ContentResult as ServiceContentResult,
  ContentServiceStatusValue,
  OptionalContent,
} from './contentServiceProtocol';
import {
  parseCollection,
  parseDetail,
  parseFilmography,
  parsePerson,
  parseSeason,
  type Episode,
  type TitleDetail,
} from './detail';
import { parseRatings, type Ratings } from './detailPresentation';
import { parseIconicStudios, type IconicStudio } from './iconicStudios';
import type { MediaType } from './library';
import { onGrantEnded, relayFetch, useHeldGrants } from './relayFetch';
import { retryAfterMs } from './retryAfter';
import { seriesShape, toTitle, type Details } from './tmdb';
import { parseTitleFacts, type TitleFacts } from './titleFacts';
import {
  clearTmdbCache,
  onTmdbThrottle,
  TMDB_PROXY_KEY,
  tmdbFetch,
  tmdbJson,
  tmdbMissing,
} from './tmdbCache';
import { keptByEdge, rememberAtlasMetadata, withSharedTitleMetadata } from './titleMetadata';
import { reuse } from './reuse';
import { parseRecommendationSlides } from './recommend';
import { discoverParams } from './catalog';
import { searchStream, type Hit } from './search';
import { searchSources } from './searchSources';
import { parseKidsHomeCatalogue } from './kidsHome';
import { ContentImportAuthority } from './contentImportAuthority';
import {
  fetchFilterCounts,
  fetchPeopleCounts,
  filterPeople,
  filterTitles,
  FilterUnavailable,
  searchFilterValues,
  searchTraitValues,
} from './filterRoutes';
import {
  countriesFrom,
  mergeServices,
  serviceProviderEntries,
  servicesFrom,
} from '../settings/services';

const TMDB = 'https://api.themoviedb.org/3';
const MAX_ATLAS_TITLE_CURSORS = 64;

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
  /** Session discovery configures the one Worker-owned Atlas source; queries never carry provider URLs. */
  configureAtlas?(base: string | null): void;
}

/** Mutable only inside the Worker: an anonymous session starts keyless, then a library authority may bind keys. */
export class WorkerContentCredentials implements ContentCredentialSource {
  #source?: ContentCredentialSource;
  #atlas: string | null | undefined;

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
    return this.#atlas ?? undefined;
  }

  configureAtlas(base: string | null): void {
    this.#atlas = base?.replace(/\/$/, '') ?? null;
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

interface AtlasTitleCursor {
  selection: string;
  load: ReturnType<typeof filterTitles>;
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

/** What a direct read of a title the active profile's policy does not establish answers. */
const REFUSED: Extract<OptionalContent<never>, { state: 'unavailable' }> = {
  state: 'unavailable',
  provider: 'atlas',
  reason: 'refused',
};

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

/** `/atlas/~<gid>/…`: an Atlas shared through a guest's grant. */
const SHARED_ATLAS = /\/atlas\/~([0-9a-f]{8})(?:[/?]|$)/;
const sharedAtlasWarned = new Set<string>();

/**
 * Whether `response` says nothing is at `url`. den-edge refuses a shared Atlas call (no grant, an unknown or revoked
 * one) with the same 404 as a missing path, so a prober learns nothing; there a 404 is not evidence of absence, and
 * reading it as one silently put TMDB fallbacks in place of the guest's whole Atlas side.
 */
function absent(url: string, response: Response): boolean {
  if (response.status !== 404) return false;
  const gid = SHARED_ATLAS.exec(url)?.[1];
  if (!gid) return true;
  if (!sharedAtlasWarned.has(gid)) {
    sharedAtlasWarned.add(gid);
    console.warn(`den: the Atlas shared by grant ${gid} answered 404; treating it as unavailable`);
  }
  return false;
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
  readonly #atlasTitleCursors = new Map<string, AtlasTitleCursor>();
  readonly #imports: ContentImportAuthority;
  readonly #statusListeners = new Set<(status: ContentServiceStatusValue) => void>();
  readonly #stopThrottle: () => void;

  constructor(
    private readonly credentials: ContentCredentialSource,
    options: ContentAuthorityOptions = {},
  ) {
    this.#tmdbFetch = options.tmdbFetch ?? tmdbFetch;
    this.#providerFetch = options.providerFetch ?? relayFetch;
    this.#now = options.now ?? Date.now;
    this.#imports = new ContentImportAuthority(() => this.#tmdbKey(), this.#tmdbFetch, this.#now);
    this.#stopThrottle = onTmdbThrottle(({ retryMs }) => {
      for (const listener of this.#statusListeners)
        listener({ kind: 'throttled', provider: 'tmdb', retryAfterMs: retryMs });
    });
    // The page holds the guest's grants and says when one ends; a `grant_expired` met here is told back to it.
    onGrantEnded((gid) => {
      for (const listener of this.#statusListeners) listener({ kind: 'grant-ended', gid });
    });
  }

  listen(listener: (status: ContentServiceStatusValue) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  close(): void {
    this.#stopThrottle();
    this.#statusListeners.clear();
    this.#atlasTitleCursors.clear();
  }

  async query(
    request: ContentRequest,
    signal: AbortSignal,
    policy?: ContentPolicy,
  ): Promise<ServiceContentResult> {
    // Source discovery is ordering-sensitive: configure synchronously before any later query can observe the old
    // source, even while paired credentials are still opening.
    if (request.kind === 'sources.configure') {
      this.#atlasTitleCursors.clear();
      this.credentials.configureAtlas?.(request.atlas);
      return { kind: 'sources.configure' };
    }
    // Likewise the grants: a query sent after them must find them held.
    if (request.kind === 'grants.configure') {
      useHeldGrants(request.grants);
      return { kind: 'grants.configure' };
    }
    await this.#wait(this.credentials.ready?.() ?? Promise.resolve(), signal);
    switch (request.kind) {
      case 'titles': {
        const titles: Details['title'][] = [];
        const retryable: ContentRef[] = [];
        let next = 0;
        const read = async () => {
          for (let ref = request.titles[next++]; ref; ref = request.titles[next++]) {
            // A title the policy does not establish is neither shown nor retried: it is not a transient failure.
            if (!(await this.#allowed(ref, policy, signal))) continue;
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
      case 'title.eligibility': {
        // A few at a time: each unknown title is one atlas read, and a whole library can be asked at once.
        const answers: boolean[] = [];
        let next = 0;
        const ask = async () => {
          for (let at = next++; at < request.titles.length; at = next++)
            answers[at] = await this.#allowed(request.titles[at]!, policy, signal);
        };
        await Promise.all(Array.from({ length: Math.min(6, request.titles.length) }, ask));
        return {
          kind: 'title.eligibility',
          allowed: request.titles.filter((_, index) => answers[index]),
        };
      }
      case 'title.detail': {
        if (!(await this.#allowed(request.title, policy, signal)))
          return { kind: 'title.detail', detail: REFUSED };
        const detail = optional(
          await this.#wait(this.detail(request.title, request.region), signal),
          'tmdb',
        );
        // TMDB's "recommendations" are a TMDB-only discovery list that no store has aged or audience-checked.
        return {
          kind: 'title.detail',
          detail:
            failsClosed(policy) && detail.state === 'ready'
              ? { state: 'ready', value: { ...detail.value, more: [] } }
              : detail,
        };
      }
      case 'prefetch.detail':
        if (await this.#allowed(request.title, policy, signal))
          await this.#wait(this.detail(request.title, request.region), signal);
        return { kind: 'prefetch.detail' };
      case 'title.external-id': {
        if (!(await this.#allowed(request.title, policy, signal)))
          return { kind: 'title.external-id', imdbId: REFUSED };
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
        if (!(await this.#allowed(request.title, policy, signal)))
          return { kind: 'season', episodes: REFUSED };
        return {
          kind: 'season',
          episodes: optional(
            await this.#wait(this.season(request.title.id, request.season), signal),
            'tmdb',
          ),
        };
      case 'title.extras':
        if (!(await this.#allowed(request.title, policy, signal)))
          return {
            kind: 'title.extras',
            extras: {
              title: request.title,
              ratings: REFUSED,
              warnings: REFUSED,
              facts: REFUSED,
              iconicStudios: REFUSED,
            },
          };
        return this.#queryExtras(request.title, request.warningCategories, signal, policy);
      case 'catalog.page':
        // TMDB's lists (discover, trending, popular, top rated, upcoming, recommendations) carry no age or audience
        // evidence, and filtering one page at a time would leave sparse or empty pages while eligible titles exist.
        // A fail-closed profile browses through the policy-aware atlas rows instead; this surface is hidden.
        if (failsClosed(policy)) return { kind: 'catalog.page', titles: [] };
        return {
          kind: 'catalog.page',
          titles: await this.#wait(this.#catalog(request.catalog, request.page), signal),
        };
      case 'search': {
        let hits: Hit[] = [];
        const atlas = this.credentials.atlas?.() ?? null;
        const restricted = failsClosed(policy);
        // Without atlas a fail-closed search has no eligibility evidence, so it finds nothing rather than TMDB's.
        if (restricted && !atlas) return { kind: 'search', hits };
        const sources = searchSources(
          this.#tmdbKey(),
          policedAtlasFetch(
            (input, init) => this.#contentFetch(input, { ...init, signal }),
            atlas ?? '',
            policy,
          ),
          atlas,
          !restricted,
        );
        for await (const batch of searchStream(request.query, sources, signal)) hits = batch;
        // People are not titles, and their pages list a TMDB filmography; a fail-closed search finds titles only.
        return {
          kind: 'search',
          hits: restricted ? hits.filter((hit) => hit.kind === 'title') : hits,
        };
      }
      case 'collection': {
        // A TMDB collection is another TMDB-only title list; a fail-closed profile's franchise is atlas'.
        if (failsClosed(policy)) return { kind: 'collection', titles: [] };
        const body = await this.#wait(
          this.#tmdb(`/collection/${request.id}`, this.#tmdbKey()),
          signal,
        );
        return {
          kind: 'collection',
          titles: body.kind === 'found' ? parseCollection(body.value) : [],
        };
      }
      case 'person': {
        const body = await this.#wait(this.#tmdb(`/person/${request.id}`, this.#tmdbKey()), signal);
        const person = body.kind === 'found' ? parsePerson(request.id, body.value) : null;
        return {
          kind: 'person',
          person:
            body.kind === 'found'
              ? person
                ? { state: 'ready', value: person }
                : { state: 'absent' }
              : optional(body, 'tmdb'),
        };
      }
      case 'person.filmography': {
        // A filmography is one unpaged TMDB list with no age evidence; it cannot be made eligible without an atlas
        // lookup per credit, so a fail-closed profile does not get one.
        if (failsClosed(policy))
          return { kind: 'person.filmography', credits: { state: 'absent' } };
        const body = await this.#wait(
          this.#tmdb(`/person/${request.id}/combined_credits`, this.#tmdbKey()),
          signal,
        );
        return {
          kind: 'person.filmography',
          credits:
            body.kind === 'found'
              ? { state: 'ready', value: parseFilmography(body.value) }
              : optional(body, 'tmdb'),
        };
      }
      case 'service.regions': {
        const body = await this.#wait(
          this.#tmdb('/watch/providers/regions', this.#tmdbKey()),
          signal,
        );
        if (body.kind !== 'found') throw this.#fault(body, 'service regions unavailable');
        return { kind: 'service.regions', regions: countriesFrom(body.value) };
      }
      case 'service.directory': {
        const region = request.region.toUpperCase();
        const answers = await Promise.all(
          (['movie', 'tv'] as const).map((media) =>
            this.#wait(
              this.#tmdb(`/watch/providers/${media}`, this.#tmdbKey(), {
                watch_region: region,
              }),
              signal,
            ),
          ),
        );
        const available = answers.flatMap((answer, index) =>
          answer.kind === 'found'
            ? [
                {
                  services: servicesFrom(
                    serviceProviderEntries(answer.value),
                    index === 0 ? 'movie' : 'tv',
                    region,
                  ),
                },
              ]
            : [],
        );
        const failed = answers.find(
          (answer): answer is Exclude<typeof answer, { kind: 'found' }> => answer.kind !== 'found',
        );
        if (!available.length)
          throw this.#fault(failed!, 'streaming service directory unavailable');
        return {
          kind: 'service.directory',
          services: mergeServices(...available.map(({ services }) => services)),
          complete: available.length === answers.length,
        };
      }
      case 'atlas.query':
        return {
          kind: 'atlas.query',
          answer: await this.#atlasQuery(request.query, signal, policy),
        };
      case 'atlas.related':
        return {
          kind: 'atlas.related',
          answer: await this.#atlasRelated(request.query, signal, policy),
        };
      case 'atlas.row':
        return { kind: 'atlas.row', titles: await this.#atlasRow(request, signal, policy) };
      case 'atlas.service.catalogs':
        return { kind: 'atlas.service.catalogs', catalogs: await this.#atlasCatalogs(signal) };
      case 'atlas.service.chart':
        return {
          kind: 'atlas.service.chart',
          titles: await this.#atlasServiceChart(request, signal, policy),
        };
      case 'atlas.recommend.shared':
      case 'atlas.recommend.personal':
        return { kind: request.kind, slides: await this.#atlasRecommend(request, signal, policy) };
      case 'import.resolve':
        return {
          kind: 'import.resolve',
          results: await this.#imports.resolve(request.lookups, signal),
        };
      case 'provider-key.check':
        return {
          kind: 'provider-key.check',
          service: request.service,
          outcome: await this.#checkProviderKey(request.service, request.candidate, signal),
        };
      case 'provider-cache.clear':
        await this.#wait(clearTmdbCache(), signal);
        return { kind: 'provider-cache.clear', service: request.service };
      default:
        throw new ContentServiceFault({
          code: 'not-ready',
          message: 'content operation is not owned by ContentAuthority yet',
          retryable: false,
        });
    }
  }

  /** `providerFetch` with the profile's policy on every request to the configured atlas. */
  #atlasFetch(atlas: string, policy: ContentPolicy | undefined): typeof fetch {
    return policedAtlasFetch(this.#providerFetch, atlas, policy);
  }

  /**
   * The one age check behind every direct read (detail, seasons, play, downloads...): is this title within the
   * profile's policy? atlas answers it (`eligible`): it holds the age, and for a Kid the made-for-audience admission
   * and the warning veto (profiles-v1 §5). An atlas from before that answer gives the public `minimumAge`, which
   * den-core's age rule decides. Anything that cannot be established — atlas not configured, unreachable, or an
   * unrecognised answer — is an unknown maturity.
   */
  async #allowed(
    ref: ContentRef,
    policy: ContentPolicy | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!isAgeRestricted(policy)) return true;
    if (!validRef(ref)) return false;
    if (policy?.approvals?.some((title) => title.type === ref.type && title.id === ref.id))
      return true;
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    // Missing evidence (no atlas, an outage, an undecodable answer) is an unknown maturity, which the policy's own
    // `unknownRatings` decides: `block` refuses, `allow` admits. It is logged so an outage is never silent.
    if (!atlas) {
      console.warn('den: no atlas to age a title; treating its maturity as unknown');
      return ageAllowed(policy, null);
    }
    const url = `${atlas}/index/title/${ref.type === 'tv' ? 'series' : 'movie'}/${ref.id}.json`;
    try {
      const answer = await this.#wait(
        reuse(`content:eligible:${policyKey(policy)}:${url}`, async () => {
          const response = await this.#atlasFetch(atlas, policy)(url);
          // A title the store has never heard of has no age evidence: unknown, which the policy then decides.
          if (absent(url, response)) return { minimumAge: null };
          if (!response.ok) throw new Error(`atlas answered ${response.status}`);
          const record = object(await response.json());
          const age = record?.minimumAge;
          return {
            eligible: typeof record?.eligible === 'boolean' ? record.eligible : undefined,
            minimumAge:
              typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 18
                ? age
                : null,
          };
        }),
        signal,
      );
      return answer.eligible ?? (await ageAllowed(policy, answer.minimumAge));
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      console.warn('den: atlas could not age a title; treating its maturity as unknown', error);
      return ageAllowed(policy, null);
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
    policy: ContentPolicy | undefined,
  ): Promise<ServiceContentResult> {
    const [identifiers, facts, iconicStudios] = await Promise.all([
      this.#wait(this.identifiers(ref), signal),
      this.#wait(this.#facts(ref, policy), signal),
      this.#wait(this.#iconicStudios(ref, policy), signal),
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

  async #checkProviderKey(
    service: 'tmdb' | 'omdb' | 'content-warnings',
    candidate: string | undefined,
    signal: AbortSignal,
  ): Promise<'accepted' | 'refused' | 'unavailable'> {
    const saved =
      service === 'tmdb'
        ? this.credentials.tmdb()
        : service === 'omdb'
          ? this.credentials.omdb()
          : this.credentials.contentWarnings();
    const key = candidate?.trim() || saved?.trim();
    if (!key) return 'refused';
    try {
      const response = await this.#wait(
        service === 'tmdb'
          ? this.#tmdbFetch(tmdbUrl('/configuration', key), { signal })
          : this.#providerFetch(service === 'omdb' ? '/ratings/check' : '/warnings/check', {
              signal,
              headers: {
                ...(service === 'content-warnings' ? { accept: 'application/json' } : {}),
                'x-api-key': key,
              },
            }),
        signal,
      );
      if (response.status === 401 || response.status === 403) return 'refused';
      if (service === 'tmdb')
        return response.ok ? 'accepted' : response.status === 404 ? 'refused' : 'unavailable';
      return response.ok || response.status === 404 ? 'accepted' : 'unavailable';
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError'))
        throw error;
      return 'unavailable';
    }
  }

  #fault(result: Exclude<ProviderResult<unknown>, { kind: 'found' }>, message: string) {
    const rateLimited = result.kind === 'unavailable' && result.reason === 'rate-limited';
    const unauthorized = result.kind === 'unavailable' && result.reason === 'unauthorized';
    return new ContentServiceFault({
      code:
        result.kind === 'missing'
          ? 'not-found'
          : result.kind === 'not-configured'
            ? 'not-configured'
            : rateLimited
              ? 'rate-limited'
              : unauthorized
                ? 'refused'
                : 'unavailable',
      message,
      retryable: result.kind === 'unavailable' && !unauthorized,
      provider: 'tmdb',
      ...(result.kind === 'unavailable' && result.retryAfterMs !== undefined
        ? { retryAfterMs: result.retryAfterMs }
        : {}),
    });
  }

  async #catalog(
    catalog: Extract<ContentRequest, { kind: 'catalog.page' }>['catalog'],
    page: number,
  ): Promise<import('./library').Title[]> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 500) return [];
    let path: string;
    let type: MediaType;
    let params: Record<string, string> = {};
    switch (catalog.kind) {
      case 'discover':
        type = catalog.query.mediaType;
        path = `/discover/${type}`;
        params = discoverParams(catalog.query);
        break;
      case 'trending':
        type = catalog.media;
        path = `/trending/${type}/${catalog.window}`;
        break;
      case 'popular':
        type = catalog.media;
        path = `/${type}/popular`;
        break;
      case 'top-rated':
        type = catalog.media;
        path = `/${type}/top_rated`;
        break;
      case 'upcoming':
        type = 'movie';
        path = '/movie/upcoming';
        break;
      case 'recommendations':
        type = catalog.title.type;
        path = `/${type}/${catalog.title.id}/recommendations`;
        break;
    }
    const body = await this.#tmdb(path, this.#tmdbKey(), { ...params, page: String(page) });
    if (body.kind === 'missing') return [];
    if (body.kind !== 'found')
      throw new ContentServiceFault({
        code: body.kind === 'not-configured' ? 'not-configured' : 'unavailable',
        message: 'catalog provider unavailable',
        retryable: body.kind !== 'not-configured',
        provider: 'tmdb',
        ...(body.kind === 'unavailable' && body.retryAfterMs !== undefined
          ? { retryAfterMs: body.retryAfterMs }
          : {}),
      });
    return Array.isArray(body.value.results)
      ? body.value.results.flatMap((raw) => {
          const value = object(raw);
          const id = value?.id;
          const title = typeof id === 'number' && value ? toTitle({ type, id }, value) : null;
          return title ? [title] : [];
        })
      : [];
  }

  #contentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(TMDB) ? this.#tmdbFetch(input, init) : this.#providerFetch(input, init);
  }

  async #atlasQuery(
    query: Extract<ContentRequest, { kind: 'atlas.query' }>['query'],
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./contentServiceProtocol').ContentAtlasAnswer>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return { state: 'not-configured' };
    const policed = this.#atlasFetch(atlas, policy);
    const fetchImpl: typeof fetch = (input, init) => policed(input, { ...init, signal });
    try {
      switch (query.operation) {
        case 'kids-home':
          return this.#atlasKidsHome(atlas, signal, policy);
        case 'kids-row':
          return this.#atlasKidsRow(atlas, query, signal, policy);
        case 'titles': {
          return {
            state: 'ready',
            value: {
              operation: 'titles',
              titles: await this.#atlasTitlePage(atlas, query, signal, policy),
            },
          };
        }
        case 'counts':
          return {
            state: 'ready',
            value: {
              operation: 'counts',
              counts: await fetchFilterCounts(atlas, query.type, query.items, {
                signal,
                fetchImpl,
              }),
            },
          };
        case 'values':
          return {
            state: 'ready',
            value: {
              operation: 'values',
              values: await searchFilterValues(
                atlas,
                query.type,
                query.valueKind,
                query.query,
                query.items,
                { signal, fetchImpl },
              ),
            },
          };
        case 'people': {
          const answer = await filterPeople(
            atlas,
            query.type,
            query.items,
            query.traits,
            query.order,
            { fetchImpl },
          )(query.page);
          return { state: 'ready', value: { operation: 'people', ...answer } };
        }
        case 'people-counts':
          return {
            state: 'ready',
            value: {
              operation: 'people-counts',
              counts: await fetchPeopleCounts(atlas, query.type, query.items, query.traits, {
                signal,
                fetchImpl,
              }),
            },
          };
        case 'trait-values':
          return {
            state: 'ready',
            value: {
              operation: 'trait-values',
              values: await searchTraitValues(
                atlas,
                query.type,
                query.trait,
                query.query,
                query.items,
                query.traits,
                { signal, fetchImpl },
              ),
            },
          };
      }
    } catch (error) {
      if (error instanceof FilterUnavailable) return { state: 'absent' };
      if (error instanceof ContentServiceFault) throw error;
      if ((error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  async #atlasKidsHome(
    atlas: string,
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./contentServiceProtocol').ContentAtlasAnswer>> {
    const url = `${atlas}/index/kids-home.json`;
    try {
      return await this.#wait(
        reuse(`content:kids-home:${atlas}`, async () => {
          const response = await this.#atlasFetch(atlas, policy)(url);
          if (absent(url, response)) return { state: 'absent' } as const;
          if (!response.ok) throw new Error(`atlas answered ${response.status}`);
          return {
            state: 'ready',
            value: { operation: 'kids-home', rows: parseKidsHomeCatalogue(await response.json()) },
          } as const;
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  async #atlasKidsRow(
    atlas: string,
    query: Extract<
      Extract<ContentRequest, { kind: 'atlas.query' }>['query'],
      { operation: 'kids-row' }
    >,
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./contentServiceProtocol').ContentAtlasAnswer>> {
    const source = query.source;
    const policed = this.#atlasFetch(atlas, policy);
    try {
      let titles: import('./library').Title[];
      if (source.kind === 'filter') {
        const items = source.selection.map((item) => {
          const at = item.indexOf(':');
          return { kind: item.slice(0, at), id: item.slice(at + 1) };
        });
        const selection = JSON.stringify([atlas, 'kids', source, policyKey(policy)]);
        let cursor = this.#atlasTitleCursors.get(query.cursor);
        if (cursor && cursor.selection !== selection)
          throw new ContentServiceFault({
            code: 'invalid-request',
            message: 'Kids Home cursor selection cannot change',
            retryable: false,
            provider: 'atlas',
          });
        if (!cursor) {
          while (this.#atlasTitleCursors.size >= MAX_ATLAS_TITLE_CURSORS) {
            const oldest = this.#atlasTitleCursors.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#atlasTitleCursors.delete(oldest);
          }
          cursor = {
            selection,
            load: filterTitles(atlas, source.type, items, { fetchImpl: policed }),
          };
        } else this.#atlasTitleCursors.delete(query.cursor);
        this.#atlasTitleCursors.set(query.cursor, cursor);
        titles = await cursor.load(query.page, signal);
        if (!titles.length && this.#atlasTitleCursors.get(query.cursor) === cursor)
          this.#atlasTitleCursors.delete(query.cursor);
      } else {
        const pageSize = source.kind === 'query' ? 40 : 24;
        const skip = (query.page - 1) * pageSize;
        const url =
          source.kind === 'query'
            ? `${atlas}/index/query.json?${new URLSearchParams({
                q: source.query,
                skip: String(skip),
                limit: String(pageSize),
              })}`
            : `${atlas}/index/franchise/${source.type === 'tv' ? 'series' : 'movie'}/${source.id}.json`;
        const body = await reuse(`content:${policyKey(policy)}:${url}`, async () => {
          const response = await policed(url, { signal });
          if (absent(url, response)) return null;
          if (!response.ok) throw new Error(`atlas answered ${response.status}`);
          return object(await response.json());
        });
        if (!body) return { state: 'absent' };
        const raw = source.kind === 'query' ? body.hits : body.members;
        const candidates = Array.isArray(raw)
          ? source.kind === 'query'
            ? raw.filter(
                (candidate) =>
                  object(candidate) &&
                  typeof object(candidate)!.score === 'number' &&
                  Number(object(candidate)!.score) >= source.minimumScore,
              )
            : raw.slice(skip, skip + pageSize)
          : [];
        titles = await withSharedTitleMetadata(
          titlesOf({ titles: candidates }),
          this.#providerFetch,
        );
      }
      return { state: 'ready', value: { operation: 'kids-row', titles } };
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      if (this.#atlasTitleCursors.has(query.cursor)) this.#atlasTitleCursors.delete(query.cursor);
      if (error instanceof ContentServiceFault) throw error;
      if (error instanceof FilterUnavailable) return { state: 'absent' };
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  async #atlasRelated(
    query: Extract<ContentRequest, { kind: 'atlas.related' }>['query'],
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./contentServiceProtocol').ContentRelatedAnswer>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return { state: 'not-configured' };
    const kind = query.title.type === 'tv' ? 'series' : 'movie';
    const policed = this.#atlasFetch(atlas, policy);
    const request = async (path: string, init?: RequestInit) => {
      try {
        const response = await policed(`${atlas}${path}`, { ...init, signal });
        if (absent(`${atlas}${path}`, response)) return null;
        if (!response.ok) throw new Error(`atlas answered ${response.status}`);
        return object(await response.json());
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        throw new Error('atlas related content is unavailable', { cause: error });
      }
    };
    const refsFrom = (
      body: Json,
      mixed: boolean,
      requireMixed = false,
    ): import('./contentServiceProtocol').ContentTitleRef[] | null => {
      if (mixed && Array.isArray(body.mixed))
        return (body.mixed as Json[]).flatMap((value) => {
          const type = value.type === 'series' ? 'tv' : value.type === 'movie' ? 'movie' : null;
          return type && Number.isSafeInteger(value.id) ? [{ type, id: value.id as number }] : [];
        });
      if (mixed && requireMixed) return null;
      if (!Array.isArray(body.ids)) return null;
      return body.ids.flatMap((id) =>
        Number.isSafeInteger(id) ? [{ type: query.title.type, id: id as number }] : [],
      );
    };
    try {
      switch (query.operation) {
        case 'list': {
          const suffix = query.limit
            ? `?${query.source === 'neighbours' ? 'k' : 'limit'}=${query.limit}`
            : '';
          const body = await request(
            `/index/${query.source}/${kind}/${query.title.id}.json${suffix}`,
          );
          if (!body) return { state: 'absent' };
          return {
            state: 'ready',
            value: { operation: 'refs', refs: refsFrom(body, query.mixed) ?? [] },
          };
        }
        case 'suggest': {
          if (isRestricted(policy)) {
            // `POST /index/suggest.json` has no policy-aware form; the GET row of the same suggestions carries one.
            const body = await request(
              `/index/suggest/${kind}/${query.title.id}.json?skip=0&limit=${query.limit ?? 100}`,
            );
            const refs = body && refsFrom(body, true, true);
            return refs
              ? { state: 'ready', value: { operation: 'refs', refs } }
              : { state: 'absent' };
          }
          const body = await request('/index/suggest.json', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              seeds: [{ type: kind, id: query.title.id }],
              ...(query.limit ? { limit: query.limit } : {}),
            }),
          });
          if (!body || !Array.isArray(body.perSeed)) return { state: 'absent' };
          const row = (body.perSeed as Json[]).find((candidate) => {
            const seed = object(candidate.seed);
            return seed?.type === kind && seed.id === query.title.id;
          });
          const refs = row && refsFrom(row, query.mixed, true);
          return refs
            ? { state: 'ready', value: { operation: 'refs', refs } }
            : { state: 'absent' };
        }
        case 'cards': {
          const body = await request(
            `/index/suggest/${kind}/${query.title.id}.json?skip=${query.skip}&limit=${query.limit}`,
          );
          if (!body) return { state: 'absent' };
          const refs = refsFrom(body, true, true);
          return refs
            ? {
                state: 'ready',
                value: { operation: 'cards', refs, titles: titlesOf(body) },
              }
            : { state: 'absent' };
        }
        case 'franchise': {
          const body = await request(`/index/franchise/${kind}/${query.title.id}.json`);
          const franchise = body && object(body.franchise);
          return franchise && typeof franchise.id === 'string' && typeof franchise.name === 'string'
            ? {
                state: 'ready',
                value: {
                  operation: 'franchise',
                  id: franchise.id,
                  name: franchise.name,
                  members: titlesOf({ titles: body.members }),
                },
              }
            : { state: 'absent' };
        }
        case 'versions': {
          const body = await request(`/index/versions/${kind}/${query.title.id}.json`);
          if (!body || !Array.isArray(body.versions)) return { state: 'absent' };
          const versions = (body.versions as Json[]).flatMap((raw) => {
            const type = raw.type === 'series' ? 'tv' : raw.type === 'movie' ? 'movie' : null;
            if (!type || !Number.isSafeInteger(raw.id)) return [];
            const title = titlesOf({ titles: [raw] })[0] ?? {
              type,
              id: raw.id as number,
              title: '',
            };
            const group = object(raw.group);
            const note =
              typeof group?.label === 'string'
                ? group.label
                : raw.kind === 'remake'
                  ? 'Remake'
                  : undefined;
            return [{ title, ...(note ? { note } : {}) }];
          });
          return { state: 'ready', value: { operation: 'versions', versions } };
        }
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  async #atlasTitlePage(
    atlas: string,
    query: Extract<
      Extract<ContentRequest, { kind: 'atlas.query' }>['query'],
      { operation: 'titles' }
    >,
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<import('./library').Title[]> {
    // The policy is part of what a cursor pages through: one opened under another profile's policy cannot continue.
    const selection = JSON.stringify([atlas, query.type, query.items, policyKey(policy)]);
    let cursor = this.#atlasTitleCursors.get(query.cursor);
    if (cursor && cursor.selection !== selection)
      throw new ContentServiceFault({
        code: 'invalid-request',
        message: 'Atlas title cursor selection cannot change',
        retryable: false,
        provider: 'atlas',
      });
    if (!cursor) {
      while (this.#atlasTitleCursors.size >= MAX_ATLAS_TITLE_CURSORS) {
        const oldest = this.#atlasTitleCursors.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#atlasTitleCursors.delete(oldest);
      }
      cursor = {
        selection,
        load: filterTitles(atlas, query.type, structuredClone(query.items), {
          fetchImpl: this.#atlasFetch(atlas, policy),
        }),
      };
    } else this.#atlasTitleCursors.delete(query.cursor);
    // Map insertion order is the LRU list. A cursor remains stable while its request-local signal changes per page.
    this.#atlasTitleCursors.set(query.cursor, cursor);
    try {
      const titles = await cursor.load(query.page, signal);
      if (!titles.length && this.#atlasTitleCursors.get(query.cursor) === cursor)
        this.#atlasTitleCursors.delete(query.cursor);
      return titles;
    } catch (error) {
      if (this.#atlasTitleCursors.get(query.cursor) === cursor)
        this.#atlasTitleCursors.delete(query.cursor);
      throw error;
    }
  }

  async #atlasRow(
    request: Extract<ContentRequest, { kind: 'atlas.row' }>,
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./library').Title[]>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return { state: 'not-configured' };
    const query = new URLSearchParams({
      ...request.where,
      skip: String((request.page - 1) * 24),
      limit: '24',
    });
    const type = request.type === 'tv' ? 'series' : 'movie';
    const url = `${atlas}/index/row/${type}.json?${query}`;
    try {
      return await this.#wait(
        reuse(`content:${policyKey(policy)}:${url}`, async () => {
          const response = await this.#atlasFetch(atlas, policy)(url);
          if (absent(url, response)) return { state: 'absent' } as const;
          if (!response.ok) throw new Error(`atlas answered ${response.status}`);
          const titles = titlesOf(await response.json());
          return {
            state: 'ready',
            value: await withSharedTitleMetadata(titles, this.#providerFetch),
          } as const;
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  async #atlasCatalogs(
    signal: AbortSignal,
  ): Promise<OptionalContent<import('./contentServiceProtocol').ContentAtlasCatalog[]>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return { state: 'not-configured' };
    try {
      return await this.#wait(
        reuse(`content:manifest:${atlas}`, async () => {
          const response = await this.#providerFetch(`${atlas}/manifest.json`);
          if (absent(`${atlas}/manifest.json`, response)) return { state: 'absent' } as const;
          if (!response.ok) throw new Error(`atlas answered ${response.status}`);
          const body = object(await response.json());
          const catalogs = Array.isArray(body?.catalogs) ? body.catalogs : [];
          const value = (catalogs as Json[]).flatMap((entry) => {
            const providerIds = Array.isArray(entry.denProviderIds)
              ? entry.denProviderIds.filter((id): id is number => Number.isSafeInteger(id))
              : [];
            const type: MediaType | null =
              entry.type === 'series' ? 'tv' : entry.type === 'movie' ? 'movie' : null;
            return providerIds.length &&
              type &&
              typeof entry.id === 'string' &&
              typeof entry.name === 'string'
              ? [{ id: entry.id, name: entry.name, type, providerIds }]
              : [];
          });
          return { state: 'ready', value } as const;
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  #atlasChartTitles(body: unknown): import('./library').Title[] {
    const metas = object(body)?.metas;
    if (!Array.isArray(metas)) return [];
    return (metas as Json[]).flatMap((meta) => {
      const type = meta.type === 'series' ? 'tv' : meta.type === 'movie' ? 'movie' : null;
      if (!type || !Number.isSafeInteger(meta.moviedb_id) || typeof meta.name !== 'string')
        return [];
      const year = Number(String(meta.releaseInfo ?? '').slice(0, 4));
      const rating = Number(meta.imdbRating);
      return [
        {
          type,
          id: meta.moviedb_id as number,
          title: meta.name,
          posterPath: typeof meta.posterPath === 'string' ? meta.posterPath : undefined,
          posterUrl: type === 'movie' && typeof meta.poster === 'string' ? meta.poster : undefined,
          year: Number.isInteger(year) && year > 1800 ? year : undefined,
          rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : undefined,
          ratingSource:
            Number.isFinite(rating) && rating > 0 && rating <= 10 ? 'justwatch-imdb' : undefined,
          imdbId: typeof meta.imdb_id === 'string' ? meta.imdb_id : undefined,
          arrivesAt: typeof meta.denAt === 'number' ? meta.denAt * 1000 : undefined,
        },
      ];
    });
  }

  async #atlasServiceChart(
    request: Extract<ContentRequest, { kind: 'atlas.service.chart' }>,
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./library').Title[]>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return { state: 'not-configured' };
    const type = request.catalog.type === 'tv' ? 'series' : 'movie';
    const url = `${atlas}/catalog/${type}/${encodeURIComponent(request.catalog.id)}/country=${request.country}.json`;
    try {
      return await this.#wait(
        reuse(`content:chart:${policyKey(policy)}:${url}`, async () => {
          const response = await this.#atlasFetch(atlas, policy)(url);
          if (absent(url, response)) return { state: 'absent' } as const;
          if (!response.ok) throw new Error(`atlas answered ${response.status}`);
          const expectedPolicy = atlasPolicyIdentity(policy);
          if (expectedPolicy && response.headers.get('x-den-policy') !== expectedPolicy)
            throw new Error('atlas answered a chart for another content policy');
          const titles = this.#atlasChartTitles(await response.json());
          if (!keptByEdge(response)) rememberAtlasMetadata(titles, this.#providerFetch);
          return {
            state: 'ready',
            value: await withSharedTitleMetadata(titles, this.#providerFetch),
          } as const;
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  async #atlasRecommend(
    request: Extract<
      ContentRequest,
      { kind: 'atlas.recommend.shared' | 'atlas.recommend.personal' }
    >,
    signal: AbortSignal,
    policy: ContentPolicy | undefined,
  ): Promise<OptionalContent<import('./recommend').Slide[]>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return { state: 'not-configured' };
    const shared = request.kind === 'atlas.recommend.shared';
    const url = shared
      ? `${atlas}/recommend/${request.scope}.json?day=${request.day}${request.fresh ? '&fresh=1' : ''}`
      : `${atlas}/recommend`;
    const load = async (requestSignal?: AbortSignal) => {
      const response = await this.#atlasFetch(atlas, policy)(
        url,
        shared
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request.body),
              signal: requestSignal,
            },
      );
      if (absent(url, response)) return { state: 'absent' } as const;
      if (!response.ok) throw new Error(`atlas answered ${response.status}`);
      const body = object(await response.json());
      return body && Array.isArray(body.slides)
        ? ({ state: 'ready', value: parseRecommendationSlides(body.slides) } as const)
        : ({ state: 'absent' } as const);
    };
    try {
      // A daily GET is safe to share, but one caller cancelling only leaves its wait: it must not cancel the
      // underlying request for every other waiter. Personalized POSTs are request-owned and never coalesced.
      return await this.#wait(
        shared ? reuse(`content:${policyKey(policy)}:${url}`, () => load()) : load(signal),
        signal,
      );
    } catch (error) {
      if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
      return { state: 'unavailable', provider: 'atlas', reason: 'network' };
    }
  }

  #facts(ref: ContentRef, policy: ContentPolicy | undefined): Promise<ProviderResult<TitleFacts>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return Promise.resolve({ kind: 'not-configured' });
    const type = ref.type === 'tv' ? 'series' : 'movie';
    return this.#join(`facts\0${ref.type}:${ref.id}\0${atlas}\0${policyKey(policy)}`, async () => {
      const response = await this.#provider(
        `${atlas}/index/title/${type}/${ref.id}.json`,
        '',
        {},
        this.#atlasFetch(atlas, policy),
      );
      return response.kind === 'found'
        ? { kind: 'found', value: parseTitleFacts(response.value) }
        : response;
    });
  }

  #iconicStudios(
    ref: ContentRef,
    policy: ContentPolicy | undefined,
  ): Promise<ProviderResult<IconicStudio[]>> {
    const atlas = this.credentials.atlas?.()?.replace(/\/$/, '');
    if (!atlas) return Promise.resolve({ kind: 'not-configured' });
    const type = ref.type === 'tv' ? 'series' : 'movie';
    return this.#join(
      `studios\0${ref.type}:${ref.id}\0${atlas}\0${policyKey(policy)}`,
      async () => {
        const response = await this.#provider(
          `${atlas}/index/studios/${type}/${ref.id}.json`,
          '',
          {},
          this.#atlasFetch(atlas, policy),
        );
        return response.kind === 'found'
          ? { kind: 'found', value: parseIconicStudios(response.value) }
          : response;
      },
    );
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
    fetchImpl: typeof fetch = this.#providerFetch,
  ): Promise<ProviderResult<Json>> {
    const requestHeaders = new Headers(headers);
    if (key) requestHeaders.set('x-api-key', key);
    let response: Response;
    try {
      response = await fetchImpl(path, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return unavailable('network');
    }
    if (absent(path, response)) return { kind: 'missing' };
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
    const cleanup = () => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    };
    void flight.then(cleanup, cleanup);
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
