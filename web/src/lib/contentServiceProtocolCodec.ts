import {
  CONTENT_SERVICE_PROTOCOL,
  CONTENT_SERVICE_WIRE_LIMITS,
  type ContentAtlasQuery,
  type ContentCatalogSpec,
  type ContentDiscoverQuery,
  type ContentImportLookup,
  type ContentProvider,
  type ContentProviderKey,
  type ContentRelatedQuery,
  type ContentRequest,
  type ContentResult,
  type ContentServiceClientMessage,
  type ContentServiceFailure,
  type ContentServiceServerMessage,
  type ContentServiceStatusValue,
  type ContentTitleRef,
} from './contentServiceProtocol';

export type ContentDecodeResult<T> =
  { ok: true; value: T } | { ok: false; error: ContentServiceFailure };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, max = 16_384): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const media = (value: unknown): value is 'movie' | 'tv' => value === 'movie' || value === 'tv';
const strings = (
  value: unknown,
  maximum = CONTENT_SERVICE_WIRE_LIMITS.filters,
): value is string[] =>
  Array.isArray(value) && value.length <= maximum && value.every((item) => text(item, 256));
const integers = (
  value: unknown,
  maximum = CONTENT_SERVICE_WIRE_LIMITS.filters,
): value is number[] =>
  Array.isArray(value) && value.length <= maximum && value.every((item) => integer(item));

function failure(
  code: ContentServiceFailure['code'],
  message: string,
  retryable = false,
  extra: Partial<ContentServiceFailure> = {},
): ContentServiceFailure {
  return { code, message, retryable, ...extra };
}

function protocol(value: Record<string, unknown>): ContentServiceFailure | undefined {
  return value.protocol === CONTENT_SERVICE_PROTOCOL
    ? undefined
    : failure('protocol-mismatch', 'content service protocol does not match', false, {
        expectedProtocol: CONTENT_SERVICE_PROTOCOL,
      });
}

function titleRef(value: unknown, onlyTv = false): value is ContentTitleRef {
  return (
    record(value) &&
    exact(value, ['type', 'id']) &&
    media(value.type) &&
    (!onlyTv || value.type === 'tv') &&
    integer(value.id, 1)
  );
}

function region(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
}

function serviceBase(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return !value.includes('#');
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function providerKey(value: unknown): value is ContentProviderKey {
  return value === 'tmdb' || value === 'omdb' || value === 'content-warnings';
}

function provider(value: unknown): value is ContentProvider {
  return value === 'tmdb' || value === 'ratings' || value === 'warnings' || value === 'atlas';
}

function optional<T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): value is T | undefined {
  return value === undefined || check(value);
}

function discover(value: unknown): value is ContentDiscoverQuery {
  if (
    !record(value) ||
    !exact(value, [
      'mediaType',
      'genres',
      'genreJoin',
      'keywords',
      'withoutGenres',
      'originalLanguage',
      'originCountry',
      'voteCountGte',
      'voteAverageGte',
      'releaseDateGte',
      'releaseDateLte',
      'sortBy',
      'watchProviders',
      'watchRegion',
      'monetization',
    ]) ||
    !media(value.mediaType)
  )
    return false;
  const shortText = (candidate: unknown): candidate is string => text(candidate, 128);
  return (
    optional(value.genres, integers) &&
    (value.genreJoin === undefined || value.genreJoin === 'and' || value.genreJoin === 'or') &&
    optional(value.keywords, integers) &&
    optional(value.withoutGenres, integers) &&
    optional(value.originalLanguage, shortText) &&
    optional(value.originCountry, strings) &&
    optional(value.voteCountGte, finite) &&
    optional(value.voteAverageGte, finite) &&
    optional(value.releaseDateGte, shortText) &&
    optional(value.releaseDateLte, shortText) &&
    optional(value.sortBy, shortText) &&
    optional(value.watchProviders, integers) &&
    (value.watchRegion === undefined || region(value.watchRegion)) &&
    optional(value.monetization, strings)
  );
}

function catalog(value: unknown): value is ContentCatalogSpec {
  if (!record(value) || !text(value.kind, 32)) return false;
  switch (value.kind) {
    case 'discover':
      return exact(value, ['kind', 'query']) && discover(value.query);
    case 'trending':
      return (
        exact(value, ['kind', 'media', 'window']) &&
        media(value.media) &&
        (value.window === 'day' || value.window === 'week')
      );
    case 'popular':
    case 'top-rated':
      return exact(value, ['kind', 'media']) && media(value.media);
    case 'upcoming':
      return exact(value, ['kind']);
    case 'recommendations':
      return exact(value, ['kind', 'title']) && titleRef(value.title);
    default:
      return false;
  }
}

const exploreType = (value: unknown): value is 'movie' | 'tv' | 'all' =>
  value === 'movie' || value === 'tv' || value === 'all';

const filterItems = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= CONTENT_SERVICE_WIRE_LIMITS.filters &&
  value.every(
    (item) =>
      record(item) &&
      exact(item, ['kind', 'id', 'exclude']) &&
      text(item.kind, 64) &&
      text(item.id, 256) &&
      (item.exclude === undefined || typeof item.exclude === 'boolean'),
  );

function atlasQuery(value: unknown): value is ContentAtlasQuery {
  if (!record(value) || !text(value.operation, 32) || !exploreType(value.type)) return false;
  if (!filterItems(value.items)) return false;
  switch (value.operation) {
    case 'titles':
      return exact(value, ['operation', 'type', 'items', 'page']) && integer(value.page, 1);
    case 'counts':
      return exact(value, ['operation', 'type', 'items']);
    case 'values':
      return (
        exact(value, ['operation', 'type', 'items', 'valueKind', 'query']) &&
        text(value.valueKind, 64) &&
        text(value.query, CONTENT_SERVICE_WIRE_LIMITS.queryText)
      );
    case 'people':
      return (
        exact(value, ['operation', 'type', 'items', 'traits', 'order', 'page']) &&
        filterItems(value.traits) &&
        (value.order === undefined || text(value.order, 64)) &&
        integer(value.page, 1)
      );
    case 'people-counts':
      return exact(value, ['operation', 'type', 'items', 'traits']) && filterItems(value.traits);
    case 'trait-values':
      return (
        exact(value, ['operation', 'type', 'items', 'traits', 'trait', 'query']) &&
        filterItems(value.traits) &&
        text(value.trait, 64) &&
        text(value.query, CONTENT_SERVICE_WIRE_LIMITS.queryText)
      );
    default:
      return false;
  }
}

function relatedQuery(value: unknown): value is ContentRelatedQuery {
  if (!record(value) || !text(value.operation, 32) || !titleRef(value.title)) return false;
  switch (value.operation) {
    case 'list':
      return (
        exact(value, ['operation', 'source', 'title', 'mixed', 'limit']) &&
        (value.source === 'similar' || value.source === 'neighbours') &&
        typeof value.mixed === 'boolean' &&
        (value.limit === undefined ||
          (integer(value.limit, 1) && value.limit <= CONTENT_SERVICE_WIRE_LIMITS.related))
      );
    case 'suggest':
      return (
        exact(value, ['operation', 'title', 'mixed', 'limit']) &&
        typeof value.mixed === 'boolean' &&
        (value.limit === undefined ||
          (integer(value.limit, 1) && value.limit <= CONTENT_SERVICE_WIRE_LIMITS.related))
      );
    case 'cards':
      return (
        exact(value, ['operation', 'title', 'skip', 'limit']) &&
        integer(value.skip) &&
        value.skip <= CONTENT_SERVICE_WIRE_LIMITS.related &&
        integer(value.limit, 1) &&
        value.limit <= CONTENT_SERVICE_WIRE_LIMITS.related
      );
    case 'franchise':
    case 'versions':
      return exact(value, ['operation', 'title']);
    default:
      return false;
  }
}

function importLookup(value: unknown): value is ContentImportLookup {
  if (!record(value) || !text(value.id, 256) || !text(value.kind, 32)) return false;
  if (value.kind === 'search')
    return (
      exact(value, ['id', 'kind', 'query', 'media', 'page']) &&
      text(value.query, CONTENT_SERVICE_WIRE_LIMITS.queryText) &&
      (value.media === undefined || media(value.media)) &&
      (value.page === undefined || integer(value.page, 1))
    );
  if (value.kind === 'translations')
    return (
      exact(value, ['id', 'kind', 'title', 'field']) &&
      titleRef(value.title) &&
      (value.field === 'title' || value.field === 'overview')
    );
  if (value.kind === 'series-shape')
    return exact(value, ['id', 'kind', 'title']) && titleRef(value.title, true);
  if (value.kind === 'episodes')
    return (
      exact(value, ['id', 'kind', 'title', 'season']) &&
      titleRef(value.title, true) &&
      integer(value.season)
    );
  return value.kind === 'runtime' && exact(value, ['id', 'kind', 'title']) && titleRef(value.title);
}

function request(value: unknown): value is ContentRequest {
  if (!record(value) || !text(value.kind, 64)) return false;
  switch (value.kind) {
    case 'sources.configure':
      return exact(value, ['kind', 'atlas']) && serviceBase(value.atlas);
    case 'titles':
      return (
        exact(value, ['kind', 'titles']) &&
        Array.isArray(value.titles) &&
        value.titles.length <= CONTENT_SERVICE_WIRE_LIMITS.titles &&
        value.titles.every((candidate) => titleRef(candidate))
      );
    case 'title.detail':
    case 'prefetch.detail':
      return (
        exact(value, ['kind', 'title', 'region']) && titleRef(value.title) && region(value.region)
      );
    case 'title.extras':
      return (
        exact(value, ['kind', 'title', 'warningCategories']) &&
        titleRef(value.title) &&
        strings(value.warningCategories)
      );
    case 'title.external-id':
      return exact(value, ['kind', 'title']) && titleRef(value.title);
    case 'season':
      return (
        exact(value, ['kind', 'title', 'season']) &&
        titleRef(value.title, true) &&
        integer(value.season)
      );
    case 'person':
    case 'person.filmography':
    case 'collection':
      return exact(value, ['kind', 'id']) && integer(value.id, 1);
    case 'catalog.page':
      return (
        exact(value, ['kind', 'catalog', 'page']) &&
        catalog(value.catalog) &&
        integer(value.page, 1) &&
        value.page <= CONTENT_SERVICE_WIRE_LIMITS.page
      );
    case 'search':
      return (
        exact(value, ['kind', 'query']) && text(value.query, CONTENT_SERVICE_WIRE_LIMITS.queryText)
      );
    case 'service.regions':
      return exact(value, ['kind']);
    case 'service.directory':
      return exact(value, ['kind', 'region']) && region(value.region);
    case 'atlas.query':
      return exact(value, ['kind', 'query']) && atlasQuery(value.query);
    case 'atlas.related':
      return exact(value, ['kind', 'query']) && relatedQuery(value.query);
    case 'import.resolve':
      return (
        exact(value, ['kind', 'lookups']) &&
        Array.isArray(value.lookups) &&
        value.lookups.length <= CONTENT_SERVICE_WIRE_LIMITS.importLookups &&
        value.lookups.every(importLookup)
      );
    case 'provider-key.check':
      return (
        exact(value, ['kind', 'service', 'candidate']) &&
        providerKey(value.service) &&
        (value.candidate === undefined || text(value.candidate, 16_384))
      );
    default:
      return false;
  }
}

function result(value: unknown): value is ContentResult {
  if (!record(value) || !text(value.kind, 64)) return false;
  const boundedArray = (
    candidate: unknown,
    limit: number = CONTENT_SERVICE_WIRE_LIMITS.titles,
  ): candidate is unknown[] => Array.isArray(candidate) && candidate.length <= limit;
  const resource = (candidate: unknown) => {
    if (!record(candidate) || !text(candidate.state, 32)) return false;
    if (candidate.state === 'ready') return exact(candidate, ['state', 'value']);
    if (candidate.state === 'absent' || candidate.state === 'not-configured')
      return exact(candidate, ['state']);
    return (
      candidate.state === 'unavailable' &&
      exact(candidate, ['state', 'provider', 'reason', 'retryAfterMs']) &&
      (candidate.provider === undefined || provider(candidate.provider)) &&
      (candidate.reason === undefined ||
        candidate.reason === 'network' ||
        candidate.reason === 'rate-limited' ||
        candidate.reason === 'refused' ||
        candidate.reason === 'invalid-answer') &&
      (candidate.retryAfterMs === undefined || integer(candidate.retryAfterMs))
    );
  };
  switch (value.kind) {
    case 'sources.configure':
      return exact(value, ['kind']);
    case 'titles':
      return (
        exact(value, ['kind', 'titles', 'retryable']) &&
        boundedArray(value.titles) &&
        boundedArray(value.retryable) &&
        value.retryable.every((candidate) => titleRef(candidate))
      );
    case 'title.detail':
      return exact(value, ['kind', 'detail']) && resource(value.detail);
    case 'title.extras':
      return exact(value, ['kind', 'extras']) && record(value.extras);
    case 'title.external-id':
      return exact(value, ['kind', 'imdbId']) && resource(value.imdbId);
    case 'season':
      return exact(value, ['kind', 'episodes']) && resource(value.episodes);
    case 'person':
      return exact(value, ['kind', 'person']) && resource(value.person);
    case 'person.filmography':
      return exact(value, ['kind', 'credits']) && resource(value.credits);
    case 'collection':
    case 'catalog.page':
      return exact(value, ['kind', 'titles']) && boundedArray(value.titles);
    case 'atlas.query':
      return exact(value, ['kind', 'answer']) && resource(value.answer);
    case 'atlas.related':
      return exact(value, ['kind', 'answer']) && resource(value.answer);
    case 'search':
      return exact(value, ['kind', 'hits']) && boundedArray(value.hits);
    case 'service.regions':
      return exact(value, ['kind', 'regions']) && boundedArray(value.regions, 512);
    case 'service.directory':
      return (
        exact(value, ['kind', 'services', 'complete']) &&
        boundedArray(value.services, 512) &&
        typeof value.complete === 'boolean'
      );
    case 'import.resolve':
      return (
        exact(value, ['kind', 'results']) &&
        boundedArray(value.results, CONTENT_SERVICE_WIRE_LIMITS.importLookups)
      );
    case 'prefetch.detail':
      return exact(value, ['kind']);
    case 'provider-key.check':
      return (
        exact(value, ['kind', 'service', 'outcome']) &&
        providerKey(value.service) &&
        (value.outcome === 'accepted' ||
          value.outcome === 'refused' ||
          value.outcome === 'unavailable')
      );
    default:
      return false;
  }
}

function serviceFailure(value: unknown): value is ContentServiceFailure {
  if (
    !record(value) ||
    !exact(value, [
      'code',
      'message',
      'retryable',
      'provider',
      'retryAfterMs',
      'expectedProtocol',
    ]) ||
    !text(value.message, 4_096) ||
    typeof value.retryable !== 'boolean'
  )
    return false;
  const codes = new Set([
    'protocol-mismatch',
    'invalid-request',
    'not-ready',
    'not-configured',
    'not-found',
    'refused',
    'rate-limited',
    'unavailable',
    'cancelled',
    'internal',
  ]);
  return (
    typeof value.code === 'string' &&
    codes.has(value.code) &&
    (value.provider === undefined || provider(value.provider)) &&
    (value.retryAfterMs === undefined || integer(value.retryAfterMs)) &&
    (value.expectedProtocol === undefined || integer(value.expectedProtocol, 1))
  );
}

function status(value: unknown): value is ContentServiceStatusValue {
  if (!record(value) || !text(value.kind, 32)) return false;
  if (value.kind === 'ready') return exact(value, ['kind']);
  if (value.kind === 'throttled')
    return (
      exact(value, ['kind', 'provider', 'retryAfterMs']) &&
      provider(value.provider) &&
      integer(value.retryAfterMs)
    );
  return (
    value.kind === 'unavailable' &&
    exact(value, ['kind', 'provider', 'error']) &&
    (value.provider === undefined || provider(value.provider)) &&
    serviceFailure(value.error)
  );
}

export function decodeContentServiceClientMessage(
  input: unknown,
): ContentDecodeResult<ContentServiceClientMessage> {
  if (!record(input))
    return { ok: false, error: failure('invalid-request', 'content request must be an object') };
  const mismatch = protocol(input);
  if (mismatch) return { ok: false, error: mismatch };
  if (input.type === 'content-query') {
    if (
      !exact(input, ['type', 'protocol', 'requestId', 'request']) ||
      !text(input.requestId, 256) ||
      !request(input.request)
    )
      return { ok: false, error: failure('invalid-request', 'content query is invalid') };
    return { ok: true, value: input as unknown as ContentServiceClientMessage };
  }
  if (
    input.type !== 'content-cancel' ||
    !exact(input, ['type', 'protocol', 'targetRequestId']) ||
    !text(input.targetRequestId, 256)
  )
    return { ok: false, error: failure('invalid-request', 'content request type is invalid') };
  return { ok: true, value: input as unknown as ContentServiceClientMessage };
}

export function decodeContentServiceServerMessage(
  input: unknown,
): ContentDecodeResult<ContentServiceServerMessage> {
  if (!record(input))
    return { ok: false, error: failure('invalid-request', 'content reply must be an object') };
  const mismatch = protocol(input);
  if (mismatch) return { ok: false, error: mismatch };
  if (input.type === 'content-result') {
    if (
      !exact(input, ['type', 'protocol', 'requestId', 'result']) ||
      !text(input.requestId, 256) ||
      !result(input.result)
    )
      return { ok: false, error: failure('invalid-request', 'content result is invalid') };
    return { ok: true, value: input as unknown as ContentServiceServerMessage };
  }
  if (input.type === 'content-error') {
    if (
      !exact(input, ['type', 'protocol', 'requestId', 'error']) ||
      (input.requestId !== undefined && !text(input.requestId, 256)) ||
      !serviceFailure(input.error)
    )
      return { ok: false, error: failure('invalid-request', 'content error is invalid') };
    return { ok: true, value: input as unknown as ContentServiceServerMessage };
  }
  if (
    input.type !== 'content-status' ||
    !exact(input, ['type', 'protocol', 'status']) ||
    !status(input.status)
  )
    return { ok: false, error: failure('invalid-request', 'content reply type is invalid') };
  return { ok: true, value: input as unknown as ContentServiceServerMessage };
}
