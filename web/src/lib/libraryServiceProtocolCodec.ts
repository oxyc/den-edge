import {
  LIBRARY_SERVICE_PROTOCOL,
  type ContinueItem,
  type DownloadViewItem,
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
  type LibraryVersion,
  type ServiceRef,
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
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const optional = <T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): value is T | undefined => value === undefined || check(value);
const list = <T>(value: unknown, check: (candidate: unknown) => candidate is T): value is T[] =>
  Array.isArray(value) && value.every(check);
const nullable = <T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): value is T | null => value === null || check(value);

function titleRef(value: unknown): value is TitleRef {
  return (
    record(value) &&
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
    value.type === 'tv' &&
    integer(value.id) &&
    value.id > 0 &&
    integer(value.season) &&
    integer(value.episode) &&
    value.episode > 0
  );
}

const reaction = (value: unknown) =>
  value === 'seen' || value === 'dislike' || value === 'like' || value === 'love';
const standing = (value: unknown) =>
  value === 'watchlist' || value === 'in-progress' || value === 'watched';

function serviceRef(value: unknown): value is ServiceRef {
  return (
    record(value) &&
    integer(value.id) &&
    value.id > 0 &&
    typeof value.country === 'string' &&
    /^[A-Z]{2}$/.test(value.country)
  );
}

function preferencesPatch(value: unknown): value is LibraryPreferencesPatch {
  return (
    record(value) &&
    optional(value.excludedGenres, (candidate): candidate is number[] =>
      list(candidate, integer),
    ) &&
    optional(value.excludedLanguages, (candidate): candidate is string[] =>
      list(candidate, text),
    ) &&
    optional(value.hideAnime, bool) &&
    optional(value.hideWatched, bool) &&
    (value.minReleaseYear === undefined ||
      value.minReleaseYear === null ||
      (integer(value.minReleaseYear) && value.minReleaseYear >= 1800)) &&
    optional(value.services, (candidate): candidate is ServiceRef[] => list(candidate, serviceRef))
  );
}

function command(value: unknown): value is LibraryCommand {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'watchlist.add':
    case 'library.remove':
      return titleRef(value.title);
    case 'watched.set':
      return titleRef(value.title) && bool(value.watched);
    case 'reaction.set':
      return titleRef(value.title) && nullable(value.reaction, reaction);
    case 'episode-watched.set':
      return episodeRef(value.episode) && bool(value.watched);
    case 'season-watched.set':
      return (
        titleRef(value.title) &&
        value.title.type === 'tv' &&
        integer(value.season) &&
        list(
          value.episodes,
          (candidate): candidate is number => integer(candidate) && candidate > 0,
        ) &&
        new Set(value.episodes).size === value.episodes.length &&
        bool(value.watched)
      );
    case 'continue-dismissed.set':
      return titleRef(value.title) && bool(value.dismissed);
    case 'progress.record':
      return (
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
      return preferencesPatch(value.patch);
    default:
      return false;
  }
}

function selection(value: unknown): value is LibrarySelection {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'overview':
    case 'continue':
    case 'settings':
    case 'downloads':
      return true;
    case 'title':
      return titleRef(value.title);
    case 'presence':
      return list(value.titles, titleRef);
    default:
      return false;
  }
}

function query(value: unknown): value is LibraryQuery {
  return (
    record(value) &&
    value.kind === 'playback.prepare' &&
    titleRef(value.title) &&
    optional(value.episode, episodeRef) &&
    (value.episode === undefined ||
      (value.title.type === 'tv' && value.episode.id === value.title.id))
  );
}

function observation(value: unknown): value is LibraryObservation {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'title-shape':
      return (
        titleRef(value.title) &&
        value.title.type === 'tv' &&
        list(
          value.seasons,
          (candidate): candidate is { season: number; episodes: number } =>
            record(candidate) && integer(candidate.season) && integer(candidate.episodes),
        ) &&
        optional(
          value.lastAired,
          (candidate): candidate is { season: number; episode: number } =>
            record(candidate) &&
            integer(candidate.season) &&
            integer(candidate.episode) &&
            candidate.episode > 0,
        )
      );
    case 'lifecycle':
      return bool(value.visible) && bool(value.online) && bool(value.playbackActive);
    default:
      return false;
  }
}

function version(value: unknown): value is LibraryVersion {
  return (
    record(value) &&
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
    titleRef(value.title) &&
    finite(value.fraction) &&
    value.fraction >= 0 &&
    value.fraction <= 1 &&
    optional(
      value.episode,
      (candidate): candidate is { season: number; episode: number } =>
        record(candidate) &&
        integer(candidate.season) &&
        integer(candidate.episode) &&
        candidate.episode > 0,
    ) &&
    optional(value.seconds, finite) &&
    optional(value.updatedAt, integer)
  );
}

function download(value: unknown): value is DownloadViewItem {
  return (
    record(value) &&
    text(value.content) &&
    titleRef(value.title) &&
    optional(value.season, integer) &&
    optional(value.episode, integer) &&
    (value.state === 'queued' ||
      value.state === 'preparing' ||
      value.state === 'downloading' ||
      value.state === 'complete' ||
      value.state === 'failed') &&
    optional(
      value.fraction,
      (candidate): candidate is number => finite(candidate) && candidate >= 0 && candidate <= 1,
    )
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
    integer(value.season) &&
    integer(value.episode) &&
    value.episode > 0 &&
    bool(value.watched) &&
    progress(value)
  );
}

function selectionValue(value: unknown): value is LibrarySelectionValue {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'overview':
      return (
        list(value.owned, titleRef) &&
        list(value.watched, titleRef) &&
        list(value.watchlist, titleRef) &&
        list(
          value.standings,
          (
            candidate,
          ): candidate is { title: TitleRef; standing: 'watchlist' | 'in-progress' | 'watched' } =>
            record(candidate) && titleRef(candidate.title) && standing(candidate.standing),
        ) &&
        list(
          value.weighted,
          (candidate): candidate is { title: TitleRef; weight: number; updatedAt: number } =>
            record(candidate) &&
            titleRef(candidate.title) &&
            finite(candidate.weight) &&
            integer(candidate.updatedAt),
        ) &&
        record(value.seeds) &&
        list(value.seeds.watched, titleRef) &&
        list(value.seeds.watchlisted, titleRef)
      );
    case 'continue':
      return list(value.items, continueItem);
    case 'title':
      return (
        titleRef(value.title) &&
        bool(value.listed) &&
        bool(value.watched) &&
        nullable(value.reaction, reaction) &&
        nullable(value.standing, standing) &&
        nullable(value.progress, progress) &&
        list(value.episodes, episodeProgress)
      );
    case 'presence':
      return list(
        value.items,
        (
          candidate,
        ): candidate is {
          title: TitleRef;
          standing: 'watchlist' | 'in-progress' | 'watched' | null;
          reaction: 'seen' | 'dislike' | 'like' | 'love' | null;
        } =>
          record(candidate) &&
          titleRef(candidate.title) &&
          nullable(candidate.standing, standing) &&
          nullable(candidate.reaction, reaction),
      );
    case 'settings':
      return (
        record(value.preferences) &&
        list(value.preferences.excludedGenres, integer) &&
        list(value.preferences.excludedLanguages, text) &&
        bool(value.preferences.hideAnime) &&
        bool(value.preferences.hideWatched) &&
        optional(value.preferences.minReleaseYear, integer) &&
        list(value.preferences.services, serviceRef) &&
        bool(value.preferences.servicesConfigured)
      );
    case 'downloads':
      return list(value.items, download);
    default:
      return false;
  }
}

function queryResult(value: unknown): value is LibraryQueryResult {
  return (
    record(value) &&
    value.kind === 'playback.prepare' &&
    (value.action === 'start' || value.action === 'resume' || value.action === 'next') &&
    ((titleRef(value.target) && value.target.type === 'movie') || episodeRef(value.target)) &&
    nullable(
      value.resume,
      (candidate): candidate is { fraction: number; seconds?: number } =>
        record(candidate) &&
        finite(candidate.fraction) &&
        candidate.fraction >= 0 &&
        candidate.fraction <= 1 &&
        optional(candidate.seconds, finite) &&
        candidate.updatedAt === undefined,
    )
  );
}

function failure(value: unknown): value is LibraryServiceFailure {
  return (
    record(value) &&
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
    typeof value.message === 'string' &&
    bool(value.retryable) &&
    optional(value.expectedProtocol, integer)
  );
}

function sessionStatus(value: unknown): value is LibrarySessionStatus {
  if (!record(value) || !text(value.kind)) return false;
  switch (value.kind) {
    case 'ready':
      return version(value.version);
    case 'reconnecting':
      return nullable(value.version, version);
    case 'read-only':
      return version(value.version) && typeof value.reason === 'string';
    case 'moved':
      return optional(value.successor, text);
    case 'failed':
      return failure(value.error);
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
      if (!text(input.clientId) || !text(input.libraryKey)) return invalid('hello is incomplete');
      break;
    case 'command':
      if (!text(input.operationId) || !command(input.command)) return invalid('command is invalid');
      break;
    case 'query':
      if (!query(input.query)) return invalid('query is invalid');
      break;
    case 'subscribe':
      if (!text(input.subscriptionId) || !selection(input.selection))
        return invalid('subscription is invalid');
      break;
    case 'unsubscribe':
      if (!text(input.subscriptionId)) return invalid('subscriptionId is required');
      break;
    case 'observe':
      if (!observation(input.observation)) return invalid('observation is invalid');
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
      if (!text(input.requestId) || !version(input.version))
        return invalid('ready reply is invalid');
      break;
    case 'command-result':
      if (
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
    case 'query-result':
      if (!text(input.requestId) || !queryResult(input.result) || !version(input.version))
        return invalid('query result is invalid');
      break;
    case 'subscribed':
      if (!text(input.requestId) || !text(input.subscriptionId) || !version(input.version))
        return invalid('subscribed reply is invalid');
      break;
    case 'unsubscribed':
      if (!text(input.requestId) || !text(input.subscriptionId))
        return invalid('unsubscribed reply is invalid');
      break;
    case 'observed':
      if (!text(input.requestId) || !version(input.version))
        return invalid('observed reply is invalid');
      break;
    case 'status':
      if (!sessionStatus(input.status)) return invalid('session status is invalid');
      break;
    case 'update':
      if (!text(input.subscriptionId) || !version(input.version) || !selectionValue(input.value))
        return invalid('subscription update is invalid');
      break;
    case 'error':
      if (
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
