import {
  LIBRARY_SERVICE_PROTOCOL,
  LIBRARY_SERVICE_WIRE_LIMITS,
  type ContinueItem,
  type ConnectionsView,
  type DownloadReleaseDescriptor,
  type DownloadTarget,
  type DownloadTitleDescriptor,
  type DownloadViewItem,
  type HistoryItem,
  type LibraryCommand,
  type LibraryObservation,
  type LibraryPreferencesPatch,
  type LibraryQuery,
  type LibraryQueryResult,
  type LibrarySelection,
  type LibrarySelectionValue,
  type LibrarySessionStatus,
  type LibraryServiceClientMessage,
  type LibraryServiceFailure,
  type LibraryServiceServerMessage,
  type LibraryTask,
  type LibraryTaskResult,
  type LibraryVersion,
  type RatingSource,
  type RetainedBillboard,
  type RetainedBillboardScope,
  type RetainedBillboardTitle,
  type RetainedServices,
  type ServiceRef,
  type SimklView,
  type TitleRef,
} from './libraryServiceProtocol';

export type ProtocolDecodeResult<T> =
  { ok: true; value: T } | { ok: false; error: LibraryServiceFailure };

const invalid = (message: string): ProtocolDecodeResult<never> => ({
  ok: false,
  error: { code: 'invalid-request', message, retryable: false },
});

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInteger = (value: unknown): value is number => integer(value) && value > 0;
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const optional = <T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): value is T | undefined => value === undefined || check(value);
const list = <T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
  max: number = LIBRARY_SERVICE_WIRE_LIMITS.collectionItems,
): value is T[] => Array.isArray(value) && value.length <= max && value.every(check);
const nullable = <T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): value is T | null => value === null || check(value);

function titleRef(value: unknown): value is TitleRef {
  return (
    record(value) &&
    exact(value, ['type', 'id']) &&
    (value.type === 'movie' || value.type === 'tv') &&
    integer(value.id) &&
    value.id > 0
  );
}

function episodeRef(value: unknown): value is TitleRef & {
  type: 'tv';
  season: number;
  episode: number;
} {
  return (
    record(value) &&
    exact(value, ['type', 'id', 'season', 'episode']) &&
    value.type === 'tv' &&
    integer(value.id) &&
    value.id > 0 &&
    integer(value.season) &&
    integer(value.episode) &&
    value.episode > 0
  );
}

function downloadTarget(value: unknown): value is DownloadTarget {
  return (titleRef(value) && value.type === 'movie') || episodeRef(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

const apiKeyService = (value: unknown) =>
  value === 'tmdb' || value === 'omdb' || value === 'content-warnings';
const mediaServer = (value: unknown) => value === 'jellyfin' || value === 'plex';
const pin = (value: unknown): value is string => typeof value === 'string' && /^\d{4}$/.test(value);
const webUrl = (value: unknown): value is string => {
  if (!boundedText(value, 4_096)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};
const serviceBase = (value: unknown): value is string =>
  boundedText(value, 4_096) && (value.startsWith('/') || webUrl(value));

function retainedBillboardScope(value: unknown): value is RetainedBillboardScope {
  return (
    record(value) &&
    exact(value, ['kind', 'facet', 'fresh']) &&
    (value.kind === 'shared' || value.kind === 'personal') &&
    (value.facet === null || value.facet === 'movie' || value.facet === 'tv') &&
    bool(value.fresh)
  );
}

const smallText = (value: unknown): value is string => boundedText(value, 1_024);
const positiveIntegerList = (value: unknown, max = 256): value is number[] =>
  list(value, positiveInteger, max) && unique(value);

function retainedBillboardTitle(value: unknown): value is RetainedBillboardTitle {
  if (
    !record(value) ||
    !exact(value, [
      'type',
      'id',
      'title',
      'posterPath',
      'posterUrl',
      'backdropPath',
      'year',
      'releaseDate',
      'rating',
      'ratingSource',
      'votes',
      'popularity',
      'countries',
      'people',
      'collectionId',
      'genreIds',
      'primaryGenreName',
      'likely',
      'originalLanguage',
      'adult',
      'imdbId',
      'arrivesAt',
      'services',
      'why',
    ]) ||
    !titleRef({ type: value.type, id: value.id }) ||
    !smallText(value.title) ||
    !optional(value.posterPath, smallText) ||
    !optional(value.posterUrl, webUrl) ||
    !optional(value.backdropPath, smallText) ||
    !optional(value.year, integer) ||
    !optional(
      value.releaseDate,
      (candidate): candidate is string =>
        typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate),
    ) ||
    !optional(value.rating, finite) ||
    !optional(
      value.ratingSource,
      (candidate): candidate is 'tmdb' | 'justwatch-imdb' =>
        candidate === 'tmdb' || candidate === 'justwatch-imdb',
    ) ||
    !optional(value.votes, integer) ||
    !optional(value.popularity, finite) ||
    !optional(
      value.countries,
      (candidate): candidate is string[] => list(candidate, countryCode, 32) && unique(candidate),
    ) ||
    !optional(value.people, (candidate): candidate is number[] => positiveIntegerList(candidate)) ||
    !optional(value.collectionId, positiveInteger) ||
    !optional(value.genreIds, (candidate): candidate is number[] =>
      positiveIntegerList(candidate),
    ) ||
    !optional(value.primaryGenreName, smallText) ||
    !optional(value.likely, bool) ||
    !optional(value.originalLanguage, languageCode) ||
    !optional(value.adult, bool) ||
    !optional(
      value.imdbId,
      (candidate): candidate is string =>
        typeof candidate === 'string' && /^tt\d+$/.test(candidate),
    ) ||
    !optional(value.arrivesAt, integer) ||
    !optional(
      value.services,
      (candidate): candidate is string[] => list(candidate, smallText, 64) && unique(candidate),
    )
  )
    return false;
  if (value.why === undefined) return true;
  if (
    !record(value.why) ||
    !exact(value.why, [
      'score',
      'fit',
      'similar',
      'profile',
      'people',
      'confidence',
      'fresh',
      'arrived',
      'quality',
      'buzz',
      'reason',
    ])
  )
    return false;
  return (
    optional(value.why.score, finite) &&
    optional(value.why.fit, finite) &&
    optional(value.why.similar, (candidate): candidate is number | null =>
      nullable(candidate, finite),
    ) &&
    optional(value.why.profile, finite) &&
    optional(value.why.people, finite) &&
    optional(value.why.confidence, finite) &&
    optional(value.why.fresh, finite) &&
    optional(value.why.arrived, finite) &&
    optional(value.why.quality, finite) &&
    optional(value.why.buzz, finite) &&
    optional(value.why.reason, smallText)
  );
}

export function isRetainedBillboard(value: unknown): value is RetainedBillboard {
  return (
    record(value) &&
    ((value.kind === 'shared' && exact(value, ['kind', 'titles'])) ||
      (value.kind === 'personal' && exact(value, ['kind', 'at', 'titles']) && integer(value.at))) &&
    list(value.titles, retainedBillboardTitle, LIBRARY_SERVICE_WIRE_LIMITS.retainedTitles)
  );
}

export function isRetainedServices(value: unknown): value is RetainedServices {
  if (
    !record(value) ||
    !exact(value, ['routes', 'scout', 'atlas', 'reel', 'remux']) ||
    !record(value.routes) ||
    Object.keys(value.routes).length > LIBRARY_SERVICE_WIRE_LIMITS.routeServices
  )
    return false;
  const addon = (candidate: unknown): candidate is { install: string; base: string } =>
    record(candidate) &&
    exact(candidate, ['install', 'base']) &&
    webUrl(candidate.install) &&
    serviceBase(candidate.base);
  return (
    Object.entries(value.routes).every(
      ([name, entries]) =>
        /^[a-z][a-z0-9-]*$/.test(name) &&
        list(
          entries,
          (entry): entry is { url: string; access?: boolean } =>
            record(entry) &&
            exact(entry, ['url', 'access']) &&
            webUrl(entry.url) &&
            optional(entry.access, bool),
          LIBRARY_SERVICE_WIRE_LIMITS.routeEntries,
        ),
    ) &&
    nullable(value.scout, addon) &&
    nullable(value.atlas, serviceBase) &&
    nullable(value.reel, serviceBase) &&
    nullable(value.remux, serviceBase)
  );
}

function downloadTitle(value: unknown): value is DownloadTitleDescriptor {
  return (
    record(value) &&
    exact(value, ['target', 'name', 'imdbId', 'posterPath', 'stillPath', 'originalLanguage']) &&
    downloadTarget(value.target) &&
    boundedText(value.name, 1_024) &&
    optional(value.imdbId, (candidate): candidate is string => boundedText(candidate, 128)) &&
    optional(value.posterPath, (candidate): candidate is string => boundedText(candidate, 2_048)) &&
    optional(value.stillPath, (candidate): candidate is string => boundedText(candidate, 2_048)) &&
    optional(value.originalLanguage, languageCode)
  );
}

function downloadRelease(value: unknown): value is DownloadReleaseDescriptor {
  return (
    record(value) &&
    exact(value, ['identity', 'label', 'sizeBytes', 'cached']) &&
    boundedText(value.identity, 4_096) &&
    boundedText(value.label, 4_096) &&
    optional(
      value.sizeBytes,
      (candidate): candidate is number => integer(candidate) && candidate > 0,
    ) &&
    optional(value.cached, bool)
  );
}

const reaction = (value: unknown) =>
  value === 'seen' || value === 'dislike' || value === 'like' || value === 'love';
const standing = (value: unknown) =>
  value === 'watchlist' || value === 'in-progress' || value === 'watched';
const languageCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z]{2}$/.test(value);
const countryCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{2}$/.test(value);
const locator = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const base64url32 = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const libraryKey = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length !== 44) return false;
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
};
const ratingSource = (value: unknown): value is RatingSource =>
  value === 'imdb' || value === 'tmdb' || value === 'rottenTomatoes' || value === 'metacritic';
const unique = <T>(values: readonly T[], key: (value: T) => string = String): boolean =>
  new Set(values.map(key)).size === values.length;

function serviceRef(value: unknown): value is ServiceRef {
  return (
    record(value) &&
    exact(value, ['id', 'country']) &&
    integer(value.id) &&
    value.id > 0 &&
    countryCode(value.country)
  );
}

function legacyClock(value: unknown): value is {
  device?: string;
  last?: [milliseconds: number, counter: number, device: string];
} {
  return (
    record(value) &&
    exact(value, ['device', 'last']) &&
    optional(
      value.device,
      (candidate): candidate is string =>
        typeof candidate === 'string' && /^[0-9a-f]{16}$/.test(candidate),
    ) &&
    optional(
      value.last,
      (candidate): candidate is [number, number, string] =>
        Array.isArray(candidate) &&
        candidate.length === 3 &&
        integer(candidate[0]) &&
        integer(candidate[1]) &&
        text(candidate[2]),
    )
  );
}

function preferencesPatch(value: unknown): value is LibraryPreferencesPatch {
  if (
    !record(value) ||
    !Object.values(value).some((candidate) => candidate !== undefined) ||
    !exact(value, [
      'excludedGenres',
      'excludedLanguages',
      'hideAnime',
      'hideWatched',
      'minReleaseYear',
      'audioLanguage',
      'subtitleLanguage',
      'shownSubtitleLanguages',
      'subtitlesPerLanguage',
      'autoSkipSegments',
      'autoplayTrailers',
      'ratingSources',
      'shownWarnings',
      'watchRegion',
      'services',
      'maturityCeiling',
    ])
  )
    return false;

  const genres = value.excludedGenres;
  const excludedLanguages = value.excludedLanguages;
  const shownSubtitleLanguages = value.shownSubtitleLanguages;
  const shownWarnings = value.shownWarnings;
  const sources = value.ratingSources;
  const services = value.services;
  return (
    (genres === undefined ||
      (list(genres, (candidate): candidate is number => integer(candidate) && candidate > 0, 256) &&
        unique(genres))) &&
    (excludedLanguages === undefined ||
      (list(excludedLanguages, languageCode, 256) && unique(excludedLanguages))) &&
    optional(value.hideAnime, bool) &&
    optional(value.hideWatched, bool) &&
    (value.minReleaseYear === undefined ||
      value.minReleaseYear === null ||
      (integer(value.minReleaseYear) &&
        value.minReleaseYear >= 1800 &&
        value.minReleaseYear <= 3000)) &&
    optional(value.audioLanguage, (candidate): candidate is string | null =>
      nullable(candidate, languageCode),
    ) &&
    optional(value.subtitleLanguage, (candidate): candidate is string | null =>
      nullable(candidate, languageCode),
    ) &&
    (shownSubtitleLanguages === undefined ||
      (list(shownSubtitleLanguages, languageCode, 256) && unique(shownSubtitleLanguages))) &&
    (value.subtitlesPerLanguage === undefined || integer(value.subtitlesPerLanguage)) &&
    optional(value.autoSkipSegments, bool) &&
    optional(value.autoplayTrailers, bool) &&
    (sources === undefined ||
      (record(sources) &&
        ((exact(sources, ['kind']) && sources.kind === 'default') ||
          (exact(sources, ['kind', 'values']) &&
            sources.kind === 'values' &&
            list(sources.values, ratingSource, 4) &&
            unique(sources.values))))) &&
    (shownWarnings === undefined || (list(shownWarnings, text, 256) && unique(shownWarnings))) &&
    optional(value.watchRegion, (candidate): candidate is string | null =>
      nullable(candidate, countryCode),
    ) &&
    (services === undefined ||
      (record(services) &&
        ((exact(services, ['kind']) && services.kind === 'default') ||
          (exact(services, ['kind', 'values']) &&
            services.kind === 'values' &&
            list(services.values, serviceRef, 256) &&
            unique(services.values, (service) => `${service.id}@${service.country}`))))) &&
    (value.maturityCeiling === undefined ||
      value.maturityCeiling === null ||
      value.maturityCeiling === 'pg13' ||
      value.maturityCeiling === 'r')
  );
}

function command(value: unknown): value is LibraryCommand {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'watchlist.add':
    case 'library.remove':
      return exact(value, ['kind', 'title']) && titleRef(value.title);
    case 'watched.set':
      return (
        exact(value, ['kind', 'title', 'watched']) && titleRef(value.title) && bool(value.watched)
      );
    case 'reaction.set':
      return (
        exact(value, ['kind', 'title', 'reaction']) &&
        titleRef(value.title) &&
        nullable(value.reaction, reaction)
      );
    case 'episode-watched.set':
      return (
        exact(value, ['kind', 'episode', 'watched']) &&
        episodeRef(value.episode) &&
        bool(value.watched)
      );
    case 'season-watched.set': {
      if (
        !exact(value, ['kind', 'title', 'season', 'episodes', 'watched']) ||
        !titleRef(value.title) ||
        value.title.type !== 'tv' ||
        !integer(value.season) ||
        !list(
          value.episodes,
          (candidate): candidate is number => integer(candidate) && candidate > 0,
          LIBRARY_SERVICE_WIRE_LIMITS.seasonEpisodes,
        ) ||
        new Set(value.episodes).size !== value.episodes.length ||
        !bool(value.watched)
      )
        return false;
      return true;
    }
    case 'continue-dismissed.set':
      return (
        exact(value, ['kind', 'title', 'dismissed']) &&
        titleRef(value.title) &&
        bool(value.dismissed)
      );
    case 'progress.record':
      return (
        exact(value, ['kind', 'title', 'episode', 'fraction', 'seconds', 'observedAt']) &&
        titleRef(value.title) &&
        optional(value.episode, episodeRef) &&
        (value.episode === undefined ||
          (value.title.type === 'tv' && value.episode.id === value.title.id)) &&
        finite(value.fraction) &&
        value.fraction >= 0 &&
        value.fraction <= 1 &&
        finite(value.seconds) &&
        value.seconds >= 0 &&
        integer(value.observedAt)
      );
    case 'preferences.patch':
      return exact(value, ['kind', 'patch']) && preferencesPatch(value.patch);
    case 'api-key.set':
      return (
        exact(value, ['kind', 'service', 'value']) &&
        apiKeyService(value.service) &&
        nullable(value.value, (candidate): candidate is string => boundedText(candidate, 16_384))
      );
    case 'parental-pin.set':
      return exact(value, ['kind', 'pin']) && nullable(value.pin, pin);
    case 'remote-access.set':
      return (
        exact(value, ['kind', 'credentials']) &&
        nullable(
          value.credentials,
          (candidate): candidate is { clientId: string; clientSecret: string } =>
            record(candidate) &&
            exact(candidate, ['clientId', 'clientSecret']) &&
            boundedText(candidate.clientId, 4_096) &&
            boundedText(candidate.clientSecret, 4_096),
        )
      );
    case 'plugin.install':
    case 'plugin.remove':
      return exact(value, ['kind', 'manifestUrl']) && webUrl(value.manifestUrl);
    case 'plugin-trust.set':
      return (
        exact(value, ['kind', 'manifestUrl', 'publicKey']) &&
        webUrl(value.manifestUrl) &&
        nullable(value.publicKey, (candidate): candidate is string => boundedText(candidate, 256))
      );
    case 'server.patch':
      return (
        exact(value, ['kind', 'server', 'value']) &&
        mediaServer(value.server) &&
        nullable(
          value.value,
          (candidate): candidate is { url: string; user?: string; credential?: string } =>
            record(candidate) &&
            exact(candidate, ['url', 'user', 'credential']) &&
            webUrl(candidate.url) &&
            optional(candidate.user, (item): item is string => boundedText(item, 4_096)) &&
            optional(candidate.credential, (item): item is string => boundedText(item, 16_384)) &&
            (value.server === 'jellyfin' || candidate.user === undefined),
        )
      );
    case 'device.heartbeat':
      return exact(value, ['kind', 'name']) && boundedText(value.name, 256);
    case 'device.remove':
      return (
        exact(value, ['kind', 'deviceId']) &&
        typeof value.deviceId === 'string' &&
        /^[0-9a-z]{1,128}$/i.test(value.deviceId)
      );
    case 'simkl.connect':
      return exact(value, ['kind', 'token']) && boundedText(value.token, 16_384);
    case 'simkl.disconnect':
      return exact(value, ['kind']);
    case 'simkl.removals.approve':
      return exact(value, ['kind', 'approvalId']) && boundedText(value.approvalId, 256);
    case 'discovery.remux.remember':
      return exact(value, ['kind', 'url']) && webUrl(value.url);
    case 'retained.services.set':
      return exact(value, ['kind', 'value']) && isRetainedServices(value.value);
    case 'retained.home-continue.set':
      return exact(value, ['kind', 'present']) && bool(value.present);
    case 'retained.billboard.set':
      return (
        exact(value, ['kind', 'scope', 'value']) &&
        retainedBillboardScope(value.scope) &&
        isRetainedBillboard(value.value) &&
        value.scope.kind === value.value.kind
      );
    case 'download.enqueue':
      return (
        exact(value, ['kind', 'title', 'release', 'candidates']) &&
        downloadTitle(value.title) &&
        downloadRelease(value.release) &&
        optional(
          value.candidates,
          (candidate): candidate is number => integer(candidate) && candidate > 0,
        )
      );
    case 'download.remove':
      return exact(value, ['kind', 'target']) && downloadTarget(value.target);
    case 'download.release.try':
      return (
        exact(value, ['kind', 'target', 'identity']) &&
        downloadTarget(value.target) &&
        boundedText(value.identity, 4_096)
      );
    default:
      return false;
  }
}

function selection(value: unknown): value is LibrarySelection {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'overview':
    case 'continue':
    case 'history':
    case 'settings':
    case 'connections':
    case 'simkl':
    case 'recovery':
    case 'runtime':
    case 'downloads':
      return exact(value, ['kind']);
    case 'title':
      return exact(value, ['kind', 'title']) && titleRef(value.title);
    case 'presence': {
      if (
        !exact(value, ['kind', 'titles']) ||
        !list(value.titles, titleRef, LIBRARY_SERVICE_WIRE_LIMITS.presenceTitles)
      )
        return false;
      return (
        new Set(value.titles.map((title) => `${title.type}:${title.id}`)).size ===
        value.titles.length
      );
    }
    default:
      return false;
  }
}

function query(value: unknown): value is LibraryQuery {
  if (!record(value) || !text(value.kind)) return false;
  if (value.kind === 'parental-pin.verify') return exact(value, ['kind', 'pin']) && pin(value.pin);
  if (value.kind === 'relay.membership') return exact(value, ['kind']);
  if (value.kind === 'key-reset.prepare') return exact(value, ['kind']);
  if (value.kind === 'history.export') return exact(value, ['kind']);
  if (value.kind === 'recovery.seal')
    return (
      exact(value, ['kind', 'locator', 'wrapKey', 'createdAt']) &&
      locator(value.locator) &&
      base64url32(value.wrapKey) &&
      integer(value.createdAt)
    );
  if (value.kind === 'pairing.handover')
    return (
      exact(value, ['kind', 'handoverKey', 'host', 'linkKey']) &&
      base64url32(value.handoverKey) &&
      boundedText(value.host, 256) &&
      optional(value.linkKey, base64url32)
    );
  if (value.kind === 'download.refresh')
    return exact(value, ['kind', 'target']) && optional(value.target, downloadTarget);
  if (value.kind === 'download.releases')
    return exact(value, ['kind', 'title']) && downloadTitle(value.title);
  if (value.kind === 'retained.services.get' || value.kind === 'retained.home-continue.get')
    return exact(value, ['kind']);
  if (value.kind === 'retained.billboard.get')
    return exact(value, ['kind', 'scope']) && retainedBillboardScope(value.scope);
  return (
    value.kind === 'playback.prepare' &&
    exact(value, ['kind', 'title', 'episode']) &&
    titleRef(value.title) &&
    optional(value.episode, episodeRef) &&
    (value.episode === undefined ||
      (value.title.type === 'tv' && value.episode.id === value.title.id))
  );
}

function task(value: unknown): value is LibraryTask {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'recovery.begin':
      return (
        exact(value, ['kind', 'locator', 'sealed', 'createdAt']) &&
        locator(value.locator) &&
        boundedText(value.sealed, 4_096) &&
        integer(value.createdAt)
      );
    case 'recovery.confirm':
    case 'recovery.abandon':
      return exact(value, ['kind', 'locator']) && locator(value.locator);
    case 'recovery.disable':
      return exact(value, ['kind']);
    case 'history.import': {
      if (
        !exact(value, ['kind', 'items']) ||
        !list(
          value.items,
          (
            candidate,
          ): candidate is Extract<LibraryTask, { kind: 'history.import' }>['items'][number] =>
            record(candidate) &&
            exact(candidate, ['title', 'watchedAt', 'episodes', 'complete']) &&
            titleRef(candidate.title) &&
            optional(candidate.watchedAt, integer) &&
            optional(
              candidate.episodes,
              (
                episodes,
              ): episodes is Array<{ season: number; episode: number; watchedAt: number }> =>
                list(
                  episodes,
                  (episode): episode is { season: number; episode: number; watchedAt: number } =>
                    record(episode) &&
                    exact(episode, ['season', 'episode', 'watchedAt']) &&
                    integer(episode.season) &&
                    integer(episode.episode) &&
                    episode.episode > 0 &&
                    integer(episode.watchedAt),
                ),
            ) &&
            optional(candidate.complete, bool) &&
            (candidate.title.type === 'movie'
              ? candidate.watchedAt !== undefined && candidate.episodes === undefined
              : candidate.watchedAt === undefined && candidate.episodes !== undefined),
          LIBRARY_SERVICE_WIRE_LIMITS.importItems,
        )
      )
        return false;
      return (
        value.items.reduce((total, item) => total + (item.episodes?.length ?? 1), 0) <=
        LIBRARY_SERVICE_WIRE_LIMITS.importItems
      );
    }
    case 'local-library.merge':
      return exact(value, ['kind', 'sourceLibraryKey']) && libraryKey(value.sourceLibraryKey);
    case 'key-reset.move':
    case 'key-reset.settle':
    case 'key-reset.adopt':
      return (
        exact(value, ['kind', 'destinationLibraryKey']) && libraryKey(value.destinationLibraryKey)
      );
    default:
      return false;
  }
}

function observation(value: unknown): value is LibraryObservation {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'title-shape': {
      if (
        !exact(value, ['kind', 'title', 'seasons', 'lastAired']) ||
        !titleRef(value.title) ||
        value.title.type !== 'tv' ||
        !list(
          value.seasons,
          (candidate): candidate is { season: number; episodes: number } =>
            record(candidate) &&
            exact(candidate, ['season', 'episodes']) &&
            integer(candidate.season) &&
            integer(candidate.episodes),
          LIBRARY_SERVICE_WIRE_LIMITS.shapeSeasons,
        ) ||
        new Set(value.seasons.map(({ season }) => season)).size !== value.seasons.length ||
        !optional(
          value.lastAired,
          (candidate): candidate is { season: number; episode: number } =>
            record(candidate) &&
            exact(candidate, ['season', 'episode']) &&
            integer(candidate.season) &&
            candidate.season > 0 &&
            integer(candidate.episode) &&
            candidate.episode > 0,
        )
      )
        return false;
      const lastAired = value.lastAired;
      if (lastAired === undefined) return true;
      if (!record(lastAired) || !integer(lastAired.season) || !integer(lastAired.episode))
        return false;
      const count = value.seasons.find(({ season }) => season === lastAired.season)?.episodes;
      return count !== undefined && lastAired.episode <= count;
    }
    case 'lifecycle':
      return (
        exact(value, ['kind', 'visible', 'online', 'playbackActive']) &&
        bool(value.visible) &&
        bool(value.online) &&
        bool(value.playbackActive)
      );
    case 'foreground-ready':
      return exact(value, ['kind']);
    default:
      return false;
  }
}

function version(value: unknown): value is LibraryVersion {
  return (
    record(value) &&
    exact(value, ['instance', 'generation', 'revision']) &&
    text(value.instance) &&
    nullable(value.generation, text) &&
    integer(value.revision)
  );
}

function progress(
  value: unknown,
): value is { fraction: number; seconds?: number; updatedAt?: number } {
  return (
    record(value) &&
    exact(value, ['fraction', 'seconds', 'updatedAt']) &&
    finite(value.fraction) &&
    value.fraction >= 0 &&
    value.fraction <= 1 &&
    optional(value.seconds, finite) &&
    optional(value.updatedAt, integer)
  );
}

function continueItem(value: unknown): value is ContinueItem {
  return (
    record(value) &&
    exact(value, ['title', 'fraction', 'episode', 'seconds', 'updatedAt']) &&
    titleRef(value.title) &&
    finite(value.fraction) &&
    value.fraction >= 0 &&
    value.fraction <= 1 &&
    optional(
      value.episode,
      (candidate): candidate is { season: number; episode: number } =>
        record(candidate) &&
        exact(candidate, ['season', 'episode']) &&
        integer(candidate.season) &&
        integer(candidate.episode) &&
        candidate.episode > 0,
    ) &&
    (value.episode === undefined || value.title.type === 'tv') &&
    optional(value.seconds, finite) &&
    optional(value.updatedAt, integer)
  );
}

function historyItem(value: unknown): value is HistoryItem {
  if (!record(value) || !titleRef(value.title)) return false;
  const title = value.title;
  return (
    exact(value, ['title', 'watchedAt', 'episode', 'episodes', 'seen']) &&
    integer(value.watchedAt) &&
    optional(
      value.episode,
      (candidate): candidate is { season: number; episode: number } =>
        record(candidate) &&
        exact(candidate, ['season', 'episode']) &&
        integer(candidate.season) &&
        integer(candidate.episode) &&
        candidate.episode > 0,
    ) &&
    (value.episode === undefined || title.type === 'tv') &&
    integer(value.episodes) &&
    (title.type === 'tv' || value.episodes === 0) &&
    optional(
      value.seen,
      (candidate): candidate is Array<{ season: number; episode: number }> =>
        title.type === 'tv' &&
        list(
          candidate,
          (episode): episode is { season: number; episode: number } =>
            record(episode) &&
            exact(episode, ['season', 'episode']) &&
            integer(episode.season) &&
            integer(episode.episode) &&
            episode.episode > 0,
        ) &&
        unique(candidate, (episode) => `${episode.season}:${episode.episode}`),
    )
  );
}

function download(value: unknown): value is DownloadViewItem {
  const release = (candidate: unknown): candidate is Omit<DownloadReleaseDescriptor, 'url'> =>
    record(candidate) &&
    exact(candidate, ['identity', 'label', 'sizeBytes', 'cached']) &&
    boundedText(candidate.identity, 4_096) &&
    boundedText(candidate.label, 4_096) &&
    optional(candidate.sizeBytes, (item): item is number => integer(item) && item > 0) &&
    optional(candidate.cached, bool);
  const status = value && record(value) ? value.status : undefined;
  const downloadFetch = (
    candidate: unknown,
  ): candidate is NonNullable<DownloadViewItem['status']['fetch']> =>
    record(candidate) &&
    exact(candidate, ['state', 'seeds', 'peers', 'service']) &&
    optional(
      candidate.state,
      (item): item is string =>
        item === 'queued' ||
        item === 'fetching' ||
        item === 'downloading' ||
        item === 'stalled' ||
        item === 'failed',
    ) &&
    optional(candidate.seeds, (item): item is number => integer(item) && item >= 0) &&
    optional(candidate.peers, (item): item is number => integer(item) && item >= 0) &&
    optional(candidate.service, (item): item is string => boundedText(item, 256));
  return (
    record(value) &&
    exact(value, [
      'content',
      'title',
      'name',
      'imdbId',
      'season',
      'episode',
      'posterPath',
      'stillPath',
      'queuedAt',
      'queuedBy',
      'release',
      'alternate',
      'status',
      'tried',
      'candidates',
      'announced',
    ]) &&
    text(value.content) &&
    titleRef(value.title) &&
    boundedText(value.name, 1_024) &&
    optional(value.imdbId, (candidate): candidate is string => boundedText(candidate, 128)) &&
    optional(value.season, integer) &&
    optional(value.episode, integer) &&
    (value.season === undefined) === (value.episode === undefined) &&
    (value.season === undefined || value.title.type === 'tv') &&
    optional(value.posterPath, (candidate): candidate is string => boundedText(candidate, 2_048)) &&
    optional(value.stillPath, (candidate): candidate is string => boundedText(candidate, 2_048)) &&
    integer(value.queuedAt) &&
    value.queuedAt >= 0 &&
    record(value.queuedBy) &&
    exact(value.queuedBy, ['device', 'name', 'isSelf']) &&
    boundedText(value.queuedBy.device, 256) &&
    bool(value.queuedBy.isSelf) &&
    optional(value.queuedBy.name, (candidate): candidate is string =>
      boundedText(candidate, 256),
    ) &&
    release(value.release) &&
    optional(value.alternate, release) &&
    record(status) &&
    exact(status, [
      'state',
      'phase',
      'fraction',
      'progressAt',
      'etaSeconds',
      'bytesPerSecond',
      'fetch',
      'service',
      'until',
      'stalled',
    ]) &&
    (status.state === 'starting' ||
      status.state === 'fetching' ||
      status.state === 'not-started' ||
      status.state === 'refused' ||
      status.state === 'paused' ||
      status.state === 'unreachable' ||
      status.state === 'ready' ||
      status.state === 'no-working-release' ||
      status.state === 'release-gone') &&
    (status.phase === 'queued' ||
      status.phase === 'downloading' ||
      status.phase === 'trouble' ||
      status.phase === 'ready') &&
    optional(
      status.fraction,
      (candidate): candidate is number => finite(candidate) && candidate >= 0 && candidate <= 1,
    ) &&
    optional(
      status.progressAt,
      (candidate): candidate is number => integer(candidate) && candidate >= 0,
    ) &&
    optional(
      status.etaSeconds,
      (candidate): candidate is number => finite(candidate) && candidate >= 0,
    ) &&
    optional(
      status.bytesPerSecond,
      (candidate): candidate is number => finite(candidate) && candidate >= 0,
    ) &&
    optional(status.fetch, downloadFetch) &&
    optional(status.service, (candidate): candidate is string => boundedText(candidate, 256)) &&
    optional(
      status.until,
      (candidate): candidate is number => integer(candidate) && candidate >= 0,
    ) &&
    bool(status.stalled) &&
    integer(value.tried) &&
    value.tried >= 0 &&
    optional(
      value.candidates,
      (candidate): candidate is number => integer(candidate) && candidate > 0,
    ) &&
    bool(value.announced)
  );
}

function preferencesView(value: unknown): boolean {
  if (
    !record(value) ||
    !exact(value, [
      'excludedGenres',
      'excludedLanguages',
      'hideAnime',
      'hideWatched',
      'minReleaseYear',
      'audioLanguage',
      'subtitleLanguage',
      'shownSubtitleLanguages',
      'subtitlesPerLanguage',
      'autoSkipSegments',
      'autoplayTrailers',
      'ratingSources',
      'shownWarnings',
      'watchRegion',
      'services',
      'servicesConfigured',
      'maturityCeiling',
    ])
  )
    return false;
  const genres = value.excludedGenres;
  const excludedLanguages = value.excludedLanguages;
  const shownSubtitleLanguages = value.shownSubtitleLanguages;
  const sources = value.ratingSources;
  const shownWarnings = value.shownWarnings;
  const services = value.services;
  return (
    list(genres, (candidate): candidate is number => integer(candidate) && candidate > 0, 256) &&
    unique(genres) &&
    list(excludedLanguages, languageCode, 256) &&
    unique(excludedLanguages) &&
    bool(value.hideAnime) &&
    bool(value.hideWatched) &&
    (value.minReleaseYear === undefined ||
      (integer(value.minReleaseYear) &&
        value.minReleaseYear >= 1800 &&
        value.minReleaseYear <= 3000)) &&
    optional(value.audioLanguage, languageCode) &&
    optional(value.subtitleLanguage, languageCode) &&
    list(shownSubtitleLanguages, languageCode, 256) &&
    unique(shownSubtitleLanguages) &&
    integer(value.subtitlesPerLanguage) &&
    bool(value.autoSkipSegments) &&
    bool(value.autoplayTrailers) &&
    list(sources, ratingSource, 4) &&
    unique(sources) &&
    list(shownWarnings, text, 256) &&
    unique(shownWarnings) &&
    optional(value.watchRegion, countryCode) &&
    list(services, serviceRef, 256) &&
    unique(services, (service) => `${service.id}@${service.country}`) &&
    bool(value.servicesConfigured) &&
    (value.servicesConfigured || services.length === 0) &&
    (value.maturityCeiling === undefined ||
      value.maturityCeiling === 'pg13' ||
      value.maturityCeiling === 'r')
  );
}

function connectionsView(value: unknown): value is ConnectionsView {
  if (
    !record(value) ||
    !exact(value, [
      'kind',
      'apiKeys',
      'parentalPinConfigured',
      'remoteAccessConfigured',
      'plugins',
      'servers',
      'devices',
      'diagnostics',
    ]) ||
    value.kind !== 'connections' ||
    !record(value.apiKeys) ||
    !exact(value.apiKeys, ['tmdb', 'omdb', 'content-warnings']) ||
    !Object.values(value.apiKeys).every(
      (candidate) =>
        record(candidate) &&
        exact(candidate, ['configured', 'masked']) &&
        candidate.configured === true &&
        boundedText(candidate.masked, 32),
    ) ||
    !bool(value.parentalPinConfigured) ||
    !bool(value.remoteAccessConfigured)
  )
    return false;
  const plugins = value.plugins;
  const servers = value.servers;
  const devices = value.devices;
  const diagnostics = value.diagnostics;
  return (
    list(
      plugins,
      (candidate): candidate is ConnectionsView['plugins'][number] =>
        record(candidate) &&
        exact(candidate, ['manifestUrl', 'signingKey', 'pendingApprovalOn']) &&
        webUrl(candidate.manifestUrl) &&
        optional(candidate.signingKey, (item): item is string => boundedText(item, 256)) &&
        list(
          candidate.pendingApprovalOn,
          (device): device is { id: string; name: string } =>
            record(device) &&
            exact(device, ['id', 'name']) &&
            boundedText(device.id, 128) &&
            boundedText(device.name, 256),
          512,
        ) &&
        unique(candidate.pendingApprovalOn, (device) => device.id),
      10_000,
    ) &&
    unique(plugins, (plugin) => plugin.manifestUrl) &&
    list(
      servers,
      (candidate): candidate is ConnectionsView['servers'][number] =>
        record(candidate) &&
        exact(candidate, ['kind', 'url', 'user']) &&
        mediaServer(candidate.kind) &&
        webUrl(candidate.url) &&
        optional(candidate.user, (item): item is string => boundedText(item, 4_096)) &&
        (candidate.kind === 'jellyfin' || candidate.user === undefined),
      2,
    ) &&
    unique(servers, (server) => server.kind) &&
    list(
      devices,
      (candidate): candidate is ConnectionsView['devices'][number] =>
        record(candidate) &&
        exact(candidate, ['id', 'name', 'kind', 'lastSeenAt', 'libraryFormat']) &&
        boundedText(candidate.id, 128) &&
        boundedText(candidate.name, 256) &&
        (candidate.kind === 'tv' || candidate.kind === 'browser') &&
        optional(candidate.lastSeenAt, integer) &&
        optional(candidate.libraryFormat, integer),
      512,
    ) &&
    unique(devices, (device) => device.id) &&
    record(diagnostics) &&
    exact(diagnostics, ['libraryFormat', 'pendingChanges', 'selfDeviceId']) &&
    integer(diagnostics.libraryFormat) &&
    integer(diagnostics.pendingChanges) &&
    boundedText(diagnostics.selfDeviceId, 128)
  );
}

function simklView(value: unknown): value is SimklView {
  return (
    record(value) &&
    exact(value, ['kind', 'connected', 'account', 'heldRemovals', 'approvalId']) &&
    value.kind === 'simkl' &&
    bool(value.connected) &&
    optional(value.account, (candidate): candidate is string => boundedText(candidate, 256)) &&
    list(value.heldRemovals, titleRef, 10_000) &&
    unique(value.heldRemovals, (title) => `${title.type}:${title.id}`) &&
    optional(value.approvalId, (candidate): candidate is string => boundedText(candidate, 256)) &&
    (value.connected ||
      (value.account === undefined &&
        value.heldRemovals.length === 0 &&
        value.approvalId === undefined)) &&
    value.heldRemovals.length > 0 === (value.approvalId !== undefined)
  );
}

function episodeProgress(value: unknown): value is {
  season: number;
  episode: number;
  watched: boolean;
  fraction: number;
  seconds?: number;
  updatedAt?: number;
} {
  return (
    record(value) &&
    exact(value, ['season', 'episode', 'watched', 'fraction', 'seconds', 'updatedAt']) &&
    integer(value.season) &&
    integer(value.episode) &&
    value.episode > 0 &&
    bool(value.watched) &&
    finite(value.fraction) &&
    value.fraction >= 0 &&
    value.fraction <= 1 &&
    optional(value.seconds, finite) &&
    optional(value.updatedAt, integer)
  );
}

function selectionValue(value: unknown): value is LibrarySelectionValue {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'overview':
      return (
        exact(value, ['kind', 'owned', 'watched', 'watchlist', 'standings', 'weighted', 'seeds']) &&
        list(value.owned, titleRef) &&
        list(value.watched, titleRef) &&
        list(value.watchlist, titleRef) &&
        list(
          value.standings,
          (
            candidate,
          ): candidate is { title: TitleRef; standing: 'watchlist' | 'in-progress' | 'watched' } =>
            record(candidate) &&
            exact(candidate, ['title', 'standing']) &&
            titleRef(candidate.title) &&
            standing(candidate.standing),
        ) &&
        list(
          value.weighted,
          (candidate): candidate is { title: TitleRef; weight: number; updatedAt: number } =>
            record(candidate) &&
            exact(candidate, ['title', 'weight', 'updatedAt']) &&
            titleRef(candidate.title) &&
            finite(candidate.weight) &&
            integer(candidate.updatedAt),
        ) &&
        record(value.seeds) &&
        exact(value.seeds, ['watched', 'watchlisted']) &&
        list(value.seeds.watched, titleRef) &&
        list(value.seeds.watchlisted, titleRef)
      );
    case 'continue':
      return (
        exact(value, ['kind', 'items', 'needsShapes']) &&
        list(value.items, continueItem) &&
        list(value.needsShapes, titleRef) &&
        value.needsShapes.every((title) => title.type === 'tv') &&
        new Set(value.items.map(({ title }) => `${title.type}:${title.id}`)).size ===
          value.items.length &&
        new Set(value.needsShapes.map((title) => `${title.type}:${title.id}`)).size ===
          value.needsShapes.length
      );
    case 'history':
      return (
        exact(value, ['kind', 'items']) &&
        list(value.items, historyItem) &&
        new Set(value.items.map(({ title }) => `${title.type}:${title.id}`)).size ===
          value.items.length
      );
    case 'title':
      return (
        exact(value, [
          'kind',
          'title',
          'listed',
          'watched',
          'reaction',
          'standing',
          'progress',
          'episodes',
        ]) &&
        titleRef(value.title) &&
        bool(value.listed) &&
        bool(value.watched) &&
        nullable(value.reaction, reaction) &&
        nullable(value.standing, standing) &&
        nullable(value.progress, progress) &&
        list(value.episodes, episodeProgress) &&
        new Set(value.episodes.map(({ season, episode }) => `${season}:${episode}`)).size ===
          value.episodes.length
      );
    case 'presence':
      return (
        exact(value, ['kind', 'items']) &&
        list(
          value.items,
          (
            candidate,
          ): candidate is {
            title: TitleRef;
            standing: 'watchlist' | 'in-progress' | 'watched' | null;
            reaction: 'seen' | 'dislike' | 'like' | 'love' | null;
          } =>
            record(candidate) &&
            exact(candidate, ['title', 'standing', 'reaction']) &&
            titleRef(candidate.title) &&
            nullable(candidate.standing, standing) &&
            nullable(candidate.reaction, reaction),
          LIBRARY_SERVICE_WIRE_LIMITS.presenceTitles,
        ) &&
        new Set(value.items.map(({ title }) => `${title.type}:${title.id}`)).size ===
          value.items.length
      );
    case 'settings':
      return exact(value, ['kind', 'preferences']) && preferencesView(value.preferences);
    case 'connections':
      return connectionsView(value);
    case 'simkl':
      return simklView(value);
    case 'recovery':
      return (
        exact(value, ['kind', 'availability', 'live', 'broken', 'notices']) &&
        (value.availability === 'ready' || value.availability === 'waits') &&
        nullable(
          value.live,
          (
            candidate,
          ): candidate is {
            createdAt: number;
            by: string;
            byName: string;
            opens: number;
            lastOpenedAt: number | null;
            reposted: boolean;
          } =>
            record(candidate) &&
            exact(candidate, ['createdAt', 'by', 'byName', 'opens', 'lastOpenedAt', 'reposted']) &&
            integer(candidate.createdAt) &&
            boundedText(candidate.by, 128) &&
            boundedText(candidate.byName, 256) &&
            integer(candidate.opens) &&
            nullable(candidate.lastOpenedAt, integer) &&
            bool(candidate.reposted),
        ) &&
        bool(value.broken) &&
        list(value.notices, (notice): notice is string => boundedText(notice, 4_096), 32)
      );
    case 'runtime':
      return (
        exact(value, ['kind', 'tmdbKey', 'pluginManifestUrls', 'privateRemuxUrl']) &&
        boundedText(value.tmdbKey, 16_384) &&
        list(value.pluginManifestUrls, webUrl, 10_000) &&
        unique(value.pluginManifestUrls) &&
        nullable(value.privateRemuxUrl, webUrl)
      );
    case 'downloads':
      return exact(value, ['kind', 'items']) && list(value.items, download);
    default:
      return false;
  }
}

function queryResult(value: unknown): value is LibraryQueryResult {
  if (!record(value) || !text(value.kind)) return false;
  if (value.kind === 'parental-pin.verify')
    return exact(value, ['kind', 'matches']) && bool(value.matches);
  if (value.kind === 'relay.membership') {
    const capability = value.capability;
    return (
      exact(value, ['kind', 'capability']) &&
      nullable(
        capability,
        (candidate): candidate is { libraryId: string; memberToken: string } =>
          record(candidate) &&
          exact(candidate, ['libraryId', 'memberToken']) &&
          typeof candidate.libraryId === 'string' &&
          /^[0-9a-f]{32}$/.test(candidate.libraryId) &&
          typeof candidate.memberToken === 'string' &&
          /^[0-9a-f]{64}$/.test(candidate.memberToken),
      )
    );
  }
  if (value.kind === 'key-reset.prepare')
    return (
      exact(value, ['kind', 'destinationLibraryKey', 'device']) &&
      libraryKey(value.destinationLibraryKey) &&
      typeof value.device === 'string' &&
      /^[0-9a-f]{16}$/.test(value.device)
    );
  if (value.kind === 'recovery.seal')
    return exact(value, ['kind', 'sealed']) && boundedText(value.sealed, 4_096);
  if (value.kind === 'pairing.handover')
    return (
      exact(value, ['kind', 'sealed', 'linkKey', 'inboxKey']) &&
      boundedText(value.sealed, 4_096) &&
      base64url32(value.linkKey) &&
      boundedText(value.inboxKey, 256)
    );
  if (value.kind === 'history.export')
    return (
      exact(value, ['kind', 'exportedAt', 'titles']) &&
      boundedText(value.exportedAt, 64) &&
      list(
        value.titles,
        (
          candidate,
        ): candidate is Extract<LibraryQueryResult, { kind: 'history.export' }>['titles'][number] =>
          record(candidate) &&
          exact(candidate, [
            'type',
            'tmdbId',
            'status',
            'reaction',
            'addedAt',
            'plays',
            'episodes',
          ]) &&
          (candidate.type === 'movie' || candidate.type === 'tv') &&
          integer(candidate.tmdbId) &&
          candidate.tmdbId > 0 &&
          (candidate.status === 'none' ||
            candidate.status === 'watchlist' ||
            candidate.status === 'inProgress' ||
            candidate.status === 'watched') &&
          nullable(candidate.reaction, reaction) &&
          nullable(candidate.addedAt, (date): date is string => boundedText(date, 64)) &&
          optional(candidate.plays, exportPlays) &&
          optional(
            candidate.episodes,
            (
              episodes,
            ): episodes is Array<{
              season: number;
              episode: number;
              plays: Array<{
                watchedAt: string | null;
                rewatch: boolean;
                source: 'den' | 'import';
              }>;
            }> =>
              list(
                episodes,
                (
                  episode,
                ): episode is {
                  season: number;
                  episode: number;
                  plays: Array<{
                    watchedAt: string | null;
                    rewatch: boolean;
                    source: 'den' | 'import';
                  }>;
                } =>
                  record(episode) &&
                  exact(episode, ['season', 'episode', 'plays']) &&
                  integer(episode.season) &&
                  integer(episode.episode) &&
                  exportPlays(episode.plays),
              ),
          ),
      )
    );
  if (value.kind === 'download.refresh')
    return exact(value, ['kind', 'refreshed']) && bool(value.refreshed);
  if (value.kind === 'download.releases') {
    const release = (candidate: unknown): boolean =>
      record(candidate) &&
      exact(candidate, ['identity', 'label', 'sizeBytes', 'cached']) &&
      boundedText(candidate.identity, 4_096) &&
      boundedText(candidate.label, 4_096) &&
      optional(candidate.sizeBytes, (item): item is number => integer(item) && item > 0) &&
      optional(candidate.cached, bool);
    return (
      exact(value, ['kind', 'releases']) &&
      (value.releases === null || (Array.isArray(value.releases) && value.releases.every(release)))
    );
  }
  if (value.kind === 'retained.services')
    return exact(value, ['kind', 'value']) && nullable(value.value, isRetainedServices);
  if (value.kind === 'retained.home-continue')
    return exact(value, ['kind', 'present']) && nullable(value.present, bool);
  if (value.kind === 'retained.billboard')
    return (
      exact(value, ['kind', 'scope', 'value']) &&
      retainedBillboardScope(value.scope) &&
      nullable(value.value, isRetainedBillboard) &&
      (value.value === null || value.scope.kind === value.value.kind)
    );
  return (
    exact(value, ['kind', 'action', 'target', 'resume']) &&
    value.kind === 'playback.prepare' &&
    (value.action === 'start' || value.action === 'resume' || value.action === 'next') &&
    ((titleRef(value.target) && value.target.type === 'movie') || episodeRef(value.target)) &&
    nullable(
      value.resume,
      (candidate): candidate is { fraction: number; seconds?: number } =>
        record(candidate) &&
        exact(candidate, ['fraction', 'seconds']) &&
        finite(candidate.fraction) &&
        candidate.fraction >= 0 &&
        candidate.fraction <= 1 &&
        optional(candidate.seconds, finite) &&
        candidate.updatedAt === undefined,
    )
  );
}

function exportPlays(value: unknown): value is Array<{
  watchedAt: string | null;
  rewatch: boolean;
  source: 'den' | 'import';
}> {
  return list(
    value,
    (
      play,
    ): play is {
      watchedAt: string | null;
      rewatch: boolean;
      source: 'den' | 'import';
    } =>
      record(play) &&
      exact(play, ['watchedAt', 'rewatch', 'source']) &&
      nullable(play.watchedAt, (date): date is string => boundedText(date, 64)) &&
      bool(play.rewatch) &&
      (play.source === 'den' || play.source === 'import'),
  );
}

function taskResult(value: unknown): value is LibraryTaskResult {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'recovery.begin':
      return (
        exact(value, ['kind', 'outcome']) &&
        (value.outcome === 'begun' ||
          value.outcome === 'full' ||
          value.outcome === 'taken' ||
          value.outcome === 'waits' ||
          value.outcome === 'failed')
      );
    case 'recovery.confirm':
      return (
        exact(value, ['kind', 'outcome']) &&
        (value.outcome === 'confirmed' || value.outcome === 'lost' || value.outcome === 'failed')
      );
    case 'recovery.abandon':
      return exact(value, ['kind', 'outcome']) && value.outcome === 'abandoned';
    case 'recovery.disable':
      return exact(value, ['kind', 'outcome']) && value.outcome === 'disabled';
    case 'history.import':
      return (
        exact(value, ['kind', 'written', 'total', 'complete']) &&
        integer(value.written) &&
        integer(value.total) &&
        value.written <= value.total &&
        bool(value.complete)
      );
    case 'local-library.merge':
      return (
        exact(value, ['kind', 'outcome']) &&
        (value.outcome === 'merged' || value.outcome === 'unavailable')
      );
    case 'key-reset.move':
    case 'key-reset.settle':
    case 'key-reset.adopt':
      return (
        exact(value, ['kind', 'outcome']) &&
        (value.outcome === 'moved' ||
          value.outcome === 'adopted' ||
          value.outcome === 'undone' ||
          value.outcome === 'held' ||
          value.outcome === 'foreign' ||
          value.outcome === 'unknown' ||
          value.outcome === 'update-required' ||
          value.outcome === 'unavailable')
      );
    default:
      return false;
  }
}

function failure(value: unknown): value is LibraryServiceFailure {
  return (
    record(value) &&
    exact(value, ['code', 'message', 'retryable', 'expectedProtocol']) &&
    (value.code === 'protocol-mismatch' ||
      value.code === 'invalid-request' ||
      value.code === 'not-ready' ||
      value.code === 'conflict' ||
      value.code === 'unauthorized' ||
      value.code === 'not-found' ||
      value.code === 'refused' ||
      value.code === 'read-only' ||
      value.code === 'moved' ||
      value.code === 'storage' ||
      value.code === 'unavailable' ||
      value.code === 'cancelled' ||
      value.code === 'internal') &&
    text(value.message) &&
    bool(value.retryable) &&
    optional(value.expectedProtocol, integer)
  );
}

function sessionStatus(value: unknown): value is LibrarySessionStatus {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'ready':
      return exact(value, ['kind', 'version']) && version(value.version);
    case 'reconnecting':
      return exact(value, ['kind', 'version']) && nullable(value.version, version);
    case 'read-only':
      return (
        exact(value, ['kind', 'version', 'reason']) && version(value.version) && text(value.reason)
      );
    case 'moved':
      return exact(value, ['kind', 'successor']) && optional(value.successor, text);
    case 'failed':
      return exact(value, ['kind', 'error']) && failure(value.error);
    default:
      return false;
  }
}

function protocol(value: Record<string, unknown>): ProtocolDecodeResult<never> | undefined {
  if (value.protocol === LIBRARY_SERVICE_PROTOCOL) return undefined;
  return {
    ok: false,
    error: {
      code: 'protocol-mismatch',
      message: `library service protocol ${String(value.protocol)} is not supported`,
      retryable: false,
      expectedProtocol: LIBRARY_SERVICE_PROTOCOL,
    },
  };
}

export function decodeLibraryServiceClientMessage(
  input: unknown,
): ProtocolDecodeResult<LibraryServiceClientMessage> {
  if (!record(input)) return invalid('library service request must be an object');
  const mismatch = protocol(input);
  if (mismatch) return mismatch;
  if (!text(input.type) || !text(input.requestId))
    return invalid('request type and requestId are required');
  switch (input.type) {
    case 'hello':
      if (
        !exact(input, [
          'type',
          'protocol',
          'requestId',
          'clientId',
          'libraryKey',
          'mode',
          'legacyClock',
        ]) ||
        !text(input.clientId) ||
        !libraryKey(input.libraryKey) ||
        (input.mode !== 'online' && input.mode !== 'local') ||
        !optional(input.legacyClock, legacyClock)
      )
        return invalid('hello is incomplete');
      break;
    case 'command':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'operationId', 'command']) ||
        !text(input.operationId) ||
        !command(input.command)
      )
        return invalid('command is invalid');
      break;
    case 'query':
      if (!exact(input, ['type', 'protocol', 'requestId', 'query']) || !query(input.query))
        return invalid('query is invalid');
      break;
    case 'task':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'operationId', 'task']) ||
        !text(input.operationId) ||
        !task(input.task)
      )
        return invalid('task is invalid');
      break;
    case 'subscribe':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'subscriptionId', 'selection']) ||
        !text(input.subscriptionId) ||
        !selection(input.selection)
      )
        return invalid('subscription is invalid');
      break;
    case 'unsubscribe':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'subscriptionId']) ||
        !text(input.subscriptionId)
      )
        return invalid('subscriptionId is required');
      break;
    case 'observe':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'observation']) ||
        !observation(input.observation)
      )
        return invalid('observation is invalid');
      break;
    default:
      return invalid(`unknown request type ${input.type}`);
  }
  return { ok: true, value: input as unknown as LibraryServiceClientMessage };
}

export function decodeLibraryServiceServerMessage(
  input: unknown,
): ProtocolDecodeResult<LibraryServiceServerMessage> {
  if (!record(input)) return invalid('library service reply must be an object');
  const mismatch = protocol(input);
  if (mismatch) return mismatch;
  if (!text(input.type)) return invalid('reply type is required');
  switch (input.type) {
    case 'ready':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'version']) ||
        !text(input.requestId) ||
        !version(input.version)
      )
        return invalid('ready reply is invalid');
      break;
    case 'command-result':
      if (
        !exact(input, [
          'type',
          'protocol',
          'requestId',
          'operationId',
          'outcome',
          'delivery',
          'version',
        ]) ||
        !text(input.requestId) ||
        !text(input.operationId) ||
        (input.outcome !== 'applied' && input.outcome !== 'unchanged') ||
        (input.delivery !== 'synced' &&
          input.delivery !== 'queued' &&
          input.delivery !== 'local') ||
        !version(input.version)
      )
        return invalid('command result is invalid');
      break;
    case 'task-result':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'operationId', 'result', 'version']) ||
        !text(input.requestId) ||
        !text(input.operationId) ||
        !taskResult(input.result) ||
        !version(input.version)
      )
        return invalid('task result is invalid');
      break;
    case 'query-result':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'result', 'version']) ||
        !text(input.requestId) ||
        !queryResult(input.result) ||
        !version(input.version)
      )
        return invalid('query result is invalid');
      break;
    case 'subscribed':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'subscriptionId', 'version']) ||
        !text(input.requestId) ||
        !text(input.subscriptionId) ||
        !version(input.version)
      )
        return invalid('subscribed reply is invalid');
      break;
    case 'unsubscribed':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'subscriptionId']) ||
        !text(input.requestId) ||
        !text(input.subscriptionId)
      )
        return invalid('unsubscribed reply is invalid');
      break;
    case 'observed':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'version']) ||
        !text(input.requestId) ||
        !version(input.version)
      )
        return invalid('observed reply is invalid');
      break;
    case 'status':
      if (!exact(input, ['type', 'protocol', 'status']) || !sessionStatus(input.status))
        return invalid('session status is invalid');
      break;
    case 'update':
      if (
        !exact(input, ['type', 'protocol', 'subscriptionId', 'version', 'value']) ||
        !text(input.subscriptionId) ||
        !version(input.version) ||
        !selectionValue(input.value)
      )
        return invalid('subscription update is invalid');
      break;
    case 'error':
      if (
        !exact(input, ['type', 'protocol', 'requestId', 'subscriptionId', 'error']) ||
        !optional(input.requestId, text) ||
        !optional(input.subscriptionId, text) ||
        !failure(input.error)
      )
        return invalid('error reply is invalid');
      break;
    default:
      return invalid(`unknown reply type ${input.type}`);
  }
  return { ok: true, value: input as unknown as LibraryServiceServerMessage };
}
