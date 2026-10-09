import type { IconicStudio } from './iconicStudios';
import type { MediaType, Title } from './library';
import type { Warning } from './contentWarnings';
import type { PersonDetail, TitleDetail, Episode, FilmCredit } from './detail';
import type { Ratings } from './detailPresentation';
import type { TitleFacts } from './titleFacts';
import type { recommendBody, Slide } from './recommend';
import type {
  FilterCounts,
  FilterItem,
  FilterPerson,
  FilterValue,
  PeopleCounts,
} from './filterRoutes';

/** The read-only content protocol is versioned independently from encrypted library state. */
export const CONTENT_SERVICE_PROTOCOL = 2 as const;
export type ContentServiceProtocol = typeof CONTENT_SERVICE_PROTOCOL;

export const CONTENT_SERVICE_WIRE_LIMITS = {
  titles: 512,
  queryText: 1_024,
  region: 2,
  page: 500,
  filters: 64,
  related: 512,
  importLookups: 10_000,
} as const;

export type ContentProvider = 'tmdb' | 'ratings' | 'warnings' | 'atlas';
export type ContentProviderKey = 'tmdb' | 'omdb' | 'content-warnings';

export interface ContentTitleRef {
  type: MediaType;
  id: number;
}

export interface ContentDiscoverQuery {
  mediaType: MediaType;
  genres?: number[];
  genreJoin?: 'and' | 'or';
  keywords?: number[];
  withoutGenres?: number[];
  originalLanguage?: string;
  originCountry?: string[];
  voteCountGte?: number;
  voteAverageGte?: number;
  releaseDateGte?: string;
  releaseDateLte?: string;
  sortBy?: string;
  watchProviders?: number[];
  watchRegion?: string;
  monetization?: string[];
}

export type ContentCatalogSpec =
  | { kind: 'discover'; query: ContentDiscoverQuery }
  | { kind: 'trending'; media: MediaType; window: 'day' | 'week' }
  | { kind: 'popular'; media: MediaType }
  | { kind: 'top-rated'; media: MediaType }
  | { kind: 'upcoming' }
  | { kind: 'recommendations'; title: ContentTitleRef };

export type ContentAtlasQuery =
  | { operation: 'titles'; type: 'movie' | 'tv' | 'all'; items: FilterItem[]; page: number }
  | { operation: 'counts'; type: 'movie' | 'tv' | 'all'; items: FilterItem[] }
  | {
      operation: 'values';
      type: 'movie' | 'tv' | 'all';
      items: FilterItem[];
      valueKind: string;
      query: string;
    }
  | {
      operation: 'people';
      type: 'movie' | 'tv' | 'all';
      items: FilterItem[];
      traits: FilterItem[];
      order?: string;
      page: number;
    }
  | {
      operation: 'people-counts';
      type: 'movie' | 'tv' | 'all';
      items: FilterItem[];
      traits: FilterItem[];
    }
  | {
      operation: 'trait-values';
      type: 'movie' | 'tv' | 'all';
      items: FilterItem[];
      traits: FilterItem[];
      trait: string;
      query: string;
    };

export type ContentAtlasAnswer =
  | { operation: 'titles'; titles: Title[] }
  | { operation: 'counts'; counts: FilterCounts | null }
  | { operation: 'values'; values: FilterValue[] | null }
  | { operation: 'people'; people: FilterPerson[]; total: number }
  | { operation: 'people-counts'; counts: PeopleCounts | null }
  | { operation: 'trait-values'; values: FilterValue[] | null };

export type ContentRelatedQuery =
  | {
      operation: 'list';
      source: 'similar' | 'neighbours';
      title: ContentTitleRef;
      mixed: boolean;
      limit?: number;
    }
  | { operation: 'suggest'; title: ContentTitleRef; mixed: boolean; limit?: number }
  | { operation: 'cards'; title: ContentTitleRef; skip: number; limit: number }
  | { operation: 'franchise'; title: ContentTitleRef }
  | { operation: 'versions'; title: ContentTitleRef };

export type ContentRelatedAnswer =
  | { operation: 'refs'; refs: ContentTitleRef[] }
  | { operation: 'cards'; refs: ContentTitleRef[]; titles: Title[] }
  | { operation: 'franchise'; id: string; name: string; members: Title[] }
  | { operation: 'versions'; versions: Array<{ title: Title; note?: string }> };

export type ContentImportLookup =
  | { id: string; kind: 'search'; query: string; media?: MediaType; page?: number }
  | {
      id: string;
      kind: 'translations';
      title: ContentTitleRef;
      field: 'title' | 'overview';
    }
  | { id: string; kind: 'series-shape'; title: ContentTitleRef & { type: 'tv' } }
  | {
      id: string;
      kind: 'episodes';
      title: ContentTitleRef & { type: 'tv' };
      season: number;
    }
  | { id: string; kind: 'runtime'; title: ContentTitleRef };

export interface ContentImportSearchHit {
  type: MediaType;
  id: number;
  name: string;
  originalName?: string;
  year?: number;
}

export type ContentRequest =
  | { kind: 'sources.configure'; atlas: string | null }
  | { kind: 'titles'; titles: ContentTitleRef[] }
  | { kind: 'title.detail'; title: ContentTitleRef; region: string }
  | { kind: 'title.extras'; title: ContentTitleRef; warningCategories: string[] }
  | { kind: 'title.external-id'; title: ContentTitleRef }
  | { kind: 'season'; title: ContentTitleRef & { type: 'tv' }; season: number }
  | { kind: 'person'; id: number }
  | { kind: 'person.filmography'; id: number }
  | { kind: 'collection'; id: number }
  | { kind: 'catalog.page'; catalog: ContentCatalogSpec; page: number }
  | { kind: 'search'; query: string }
  | { kind: 'service.regions' }
  | { kind: 'service.directory'; region: string }
  | { kind: 'atlas.query'; query: ContentAtlasQuery }
  | { kind: 'atlas.related'; query: ContentRelatedQuery }
  | { kind: 'atlas.row'; type: MediaType; where: Record<string, string>; page: number }
  | { kind: 'atlas.service.catalogs' }
  | {
      kind: 'atlas.service.chart';
      catalog: { id: string; type: MediaType };
      country: string;
    }
  | {
      kind: 'atlas.recommend.shared';
      scope: 'home' | 'movies' | 'series';
      fresh: boolean;
      day: string;
    }
  | { kind: 'atlas.recommend.personal'; body: ReturnType<typeof recommendBody> }
  | { kind: 'import.resolve'; lookups: ContentImportLookup[] }
  | { kind: 'prefetch.detail'; title: ContentTitleRef; region: string }
  | { kind: 'provider-key.check'; service: ContentProviderKey; candidate?: string };

export type OptionalContent<T> =
  | { state: 'ready'; value: T }
  | { state: 'absent' }
  | { state: 'not-configured' }
  | {
      state: 'unavailable';
      provider?: ContentProvider;
      reason?: 'network' | 'rate-limited' | 'refused' | 'invalid-answer';
      retryAfterMs?: number;
    };

export interface ContentTitleExtras {
  title: ContentTitleRef;
  ratings: OptionalContent<Ratings>;
  warnings: OptionalContent<Warning[]>;
  facts: OptionalContent<TitleFacts>;
  iconicStudios: OptionalContent<IconicStudio[]>;
}

export type ContentSearchHit =
  | { kind: 'title'; title: Title }
  | {
      kind: 'person';
      person: { id: number; name: string; profilePath?: string; knownFor?: string[] };
    };

export interface ContentServiceRegion {
  code: string;
  name: string;
}

export interface ContentServiceDirectoryEntry {
  id: number;
  name: string;
  logoPath?: string;
  priority: number;
  movies: boolean;
  series: boolean;
  variants: number[];
}

export interface ContentAtlasCatalog {
  id: string;
  name: string;
  type: MediaType;
  providerIds: number[];
}

export interface ContentImportLookupResult {
  id: string;
  value:
    | { kind: 'search'; hits: ContentImportSearchHit[] }
    | { kind: 'translations'; values: string[] }
    | {
        kind: 'series-shape';
        seasons: Array<{ season: number; episodes: number; name?: string }>;
        lastAired?: { season: number; episode: number };
      }
    | { kind: 'episodes'; episodes: Episode[] }
    | { kind: 'runtime'; minutes: number | null }
    | { kind: 'missing' };
}

export type ContentResult =
  | { kind: 'sources.configure' }
  | { kind: 'titles'; titles: Title[]; retryable: ContentTitleRef[] }
  | { kind: 'title.detail'; detail: OptionalContent<TitleDetail> }
  | { kind: 'title.extras'; extras: ContentTitleExtras }
  | { kind: 'title.external-id'; imdbId: OptionalContent<string> }
  | { kind: 'season'; episodes: OptionalContent<Episode[]> }
  | { kind: 'person'; person: OptionalContent<PersonDetail> }
  | { kind: 'person.filmography'; credits: OptionalContent<FilmCredit[]> }
  | { kind: 'collection'; titles: Title[] }
  | { kind: 'catalog.page'; titles: Title[] }
  | { kind: 'search'; hits: ContentSearchHit[] }
  | { kind: 'service.regions'; regions: ContentServiceRegion[] }
  | {
      kind: 'service.directory';
      services: ContentServiceDirectoryEntry[];
      complete: boolean;
    }
  | { kind: 'atlas.query'; answer: OptionalContent<ContentAtlasAnswer> }
  | { kind: 'atlas.related'; answer: OptionalContent<ContentRelatedAnswer> }
  | { kind: 'atlas.row'; titles: OptionalContent<Title[]> }
  | { kind: 'atlas.service.catalogs'; catalogs: OptionalContent<ContentAtlasCatalog[]> }
  | { kind: 'atlas.service.chart'; titles: OptionalContent<Title[]> }
  | { kind: 'atlas.recommend.shared'; slides: OptionalContent<Slide[]> }
  | { kind: 'atlas.recommend.personal'; slides: OptionalContent<Slide[]> }
  | { kind: 'import.resolve'; results: ContentImportLookupResult[] }
  | { kind: 'prefetch.detail' }
  | {
      kind: 'provider-key.check';
      service: ContentProviderKey;
      outcome: 'accepted' | 'refused' | 'unavailable';
    };

export type ContentResultFor<Request extends ContentRequest> = Extract<
  ContentResult,
  { kind: Request['kind'] }
>;

export type ContentServiceErrorCode =
  | 'protocol-mismatch'
  | 'invalid-request'
  | 'not-ready'
  | 'not-configured'
  | 'not-found'
  | 'refused'
  | 'rate-limited'
  | 'unavailable'
  | 'cancelled'
  | 'internal';

export interface ContentServiceFailure {
  code: ContentServiceErrorCode;
  message: string;
  retryable: boolean;
  provider?: ContentProvider;
  retryAfterMs?: number;
  expectedProtocol?: number;
}

export type ContentServiceStatusValue =
  | { kind: 'ready' }
  | { kind: 'throttled'; provider: ContentProvider; retryAfterMs: number }
  | { kind: 'unavailable'; provider?: ContentProvider; error: ContentServiceFailure };

interface ContentClientMessage {
  protocol: ContentServiceProtocol;
}

export interface ContentServiceQueryRequest extends ContentClientMessage {
  type: 'content-query';
  requestId: string;
  request: ContentRequest;
}

/** Cancellation has no reply; the page waiter is rejected immediately and late results are ignored. */
export interface ContentServiceCancelRequest extends ContentClientMessage {
  type: 'content-cancel';
  targetRequestId: string;
}

export type ContentServiceClientMessage = ContentServiceQueryRequest | ContentServiceCancelRequest;

interface ContentServerMessage {
  protocol: ContentServiceProtocol;
}

export interface ContentServiceQueryResult extends ContentServerMessage {
  type: 'content-result';
  requestId: string;
  result: ContentResult;
}

export interface ContentServiceErrorMessage extends ContentServerMessage {
  type: 'content-error';
  requestId?: string;
  error: ContentServiceFailure;
}

export interface ContentServiceStatus extends ContentServerMessage {
  type: 'content-status';
  status: ContentServiceStatusValue;
}

export type ContentServiceServerMessage =
  ContentServiceQueryResult | ContentServiceErrorMessage | ContentServiceStatus;

export function isContentServiceClientMessage(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const type = (input as { type?: unknown }).type;
  return type === 'content-query' || type === 'content-cancel';
}

export function isContentServiceServerMessage(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const type = (input as { type?: unknown }).type;
  return type === 'content-result' || type === 'content-error' || type === 'content-status';
}
