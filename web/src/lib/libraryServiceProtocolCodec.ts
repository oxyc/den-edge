import {
  LIBRARY_SERVICE_PROTOCOL,
  LIBRARY_SERVICE_WIRE_LIMITS,
  type ContinueItem,
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
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
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

const reaction = (value: unknown) =>
  value === 'seen' || value === 'dislike' || value === 'like' || value === 'love';
const standing = (value: unknown) =>
  value === 'watchlist' || value === 'in-progress' || value === 'watched';

function serviceRef(value: unknown): value is ServiceRef {
  return (
    record(value) &&
    exact(value, ['id', 'country']) &&
    integer(value.id) &&
    value.id > 0 &&
    typeof value.country === 'string' &&
    /^[A-Z]{2}$/.test(value.country)
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
  return (
    record(value) &&
    exact(value, [
      'excludedGenres',
      'excludedLanguages',
      'hideAnime',
      'hideWatched',
      'minReleaseYear',
      'services',
    ]) &&
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
  return (
    record(value) &&
    exact(value, ['kind', 'title', 'episode']) &&
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
  return (
    record(value) &&
    exact(value, ['title', 'watchedAt', 'episode', 'episodes']) &&
    titleRef(value.title) &&
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
    (value.episode === undefined || value.title.type === 'tv') &&
    integer(value.episodes) &&
    (value.title.type === 'tv' || value.episodes === 0)
  );
}

function download(value: unknown): value is DownloadViewItem {
  return (
    record(value) &&
    exact(value, ['content', 'title', 'season', 'episode', 'state', 'fraction']) &&
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
      return (
        exact(value, ['kind', 'preferences']) &&
        record(value.preferences) &&
        exact(value.preferences, [
          'excludedGenres',
          'excludedLanguages',
          'hideAnime',
          'hideWatched',
          'minReleaseYear',
          'services',
          'servicesConfigured',
        ]) &&
        list(value.preferences.excludedGenres, integer) &&
        list(value.preferences.excludedLanguages, text) &&
        bool(value.preferences.hideAnime) &&
        bool(value.preferences.hideWatched) &&
        optional(value.preferences.minReleaseYear, integer) &&
        list(value.preferences.services, serviceRef) &&
        bool(value.preferences.servicesConfigured)
      );
    case 'downloads':
      return exact(value, ['kind', 'items']) && list(value.items, download);
    default:
      return false;
  }
}

function queryResult(value: unknown): value is LibraryQueryResult {
  return (
    record(value) &&
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
        !text(input.libraryKey) ||
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
