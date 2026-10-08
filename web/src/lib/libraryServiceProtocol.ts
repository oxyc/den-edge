/**
 * Transport-independent messages for the single library authority.
 *
 * This module deliberately describes domain intent and render-facing views. Durable log rows, stamps and the
 * implementation that projects them are private to the service.
 */

export const LIBRARY_SERVICE_PROTOCOL = 1 as const;

/** Memory-safety limits for one decoded wire message, not limits on what a library may contain. */
export const LIBRARY_SERVICE_WIRE_LIMITS = {
  collectionItems: 100_000,
  presenceTitles: 512,
  shapeSeasons: 256,
  seasonEpisodes: 2_048,
} as const;

export type LibraryServiceProtocol = typeof LIBRARY_SERVICE_PROTOCOL;
export type MediaType = 'movie' | 'tv';
export type Reaction = 'seen' | 'dislike' | 'like' | 'love';
export type Standing = 'watchlist' | 'in-progress' | 'watched';
export type RatingSource = 'imdb' | 'tmdb' | 'rottenTomatoes' | 'metacritic';

export interface TitleRef {
  type: MediaType;
  id: number;
}

export interface EpisodeRef extends TitleRef {
  type: 'tv';
  season: number;
  episode: number;
}

/** A monotonic render-view version within one service instance and durable library generation. */
export interface LibraryVersion {
  instance: string;
  generation: string | null;
  revision: number;
}

export interface LibraryWatchedSetCommand {
  kind: 'watched.set';
  /** A whole-series change requires a prior `title-shape` observation or fails with `not-ready`. */
  title: TitleRef;
  watched: boolean;
}

/** A title or exact episode that can have one durable download request. */
export type DownloadTarget = (TitleRef & { type: 'movie' }) | EpisodeRef;

/** Presentation metadata retained with a download so every device can render it without refetching title detail. */
export interface DownloadTitleDescriptor {
  target: DownloadTarget;
  name: string;
  imdbId?: string;
  posterPath?: string;
  stillPath?: string;
  originalLanguage?: string;
}

/** One source release. Its URL is a play-ticket capability, not a durable-row or transport concern. */
export interface DownloadReleaseDescriptor {
  identity: string;
  label: string;
  url: string;
  sizeBytes?: number;
  cached?: boolean;
}

export type LibraryCommand =
  | { kind: 'watchlist.add'; title: TitleRef }
  | { kind: 'library.remove'; title: TitleRef }
  | LibraryWatchedSetCommand
  | { kind: 'reaction.set'; title: TitleRef; reaction: Reaction | null }
  | { kind: 'episode-watched.set'; episode: EpisodeRef; watched: boolean }
  | {
      kind: 'season-watched.set';
      title: TitleRef & { type: 'tv' };
      season: number;
      /** Exact episode numbers in this season, supplied by the caller's title detail. */
      episodes: number[];
      watched: boolean;
    }
  | { kind: 'continue-dismissed.set'; title: TitleRef; dismissed: boolean }
  | {
      kind: 'progress.record';
      title: TitleRef;
      episode?: EpisodeRef;
      fraction: number;
      seconds: number;
      observedAt: number;
    }
  | { kind: 'preferences.patch'; patch: LibraryPreferencesPatch }
  | {
      kind: 'download.enqueue';
      title: DownloadTitleDescriptor;
      release: DownloadReleaseDescriptor;
      /** Number of viable releases in the source list this release was selected from. */
      candidates?: number;
    }
  | { kind: 'download.remove'; target: DownloadTarget }
  | {
      /** Preserve the current partial release and try this release beside it. */
      kind: 'download.release.try';
      target: DownloadTarget;
      release: DownloadReleaseDescriptor;
    };

export interface LibraryPreferencesPatch {
  excludedGenres?: number[];
  excludedLanguages?: string[];
  hideAnime?: boolean;
  hideWatched?: boolean;
  minReleaseYear?: number | null;
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  shownSubtitleLanguages?: string[];
  subtitlesPerLanguage?: number;
  autoSkipSegments?: boolean;
  autoplayTrailers?: boolean;
  /** `default` restores every built-in source; `values: []` deliberately disables all sources. */
  ratingSources?: LibraryListPreferencePatch<RatingSource>;
  shownWarnings?: string[];
  watchRegion?: string | null;
  /** `default` restores guest service picks; `values: []` deliberately selects no services. */
  services?: LibraryListPreferencePatch<ServiceRef>;
  maturityCeiling?: 'pg13' | 'r' | null;
}

export type LibraryListPreferencePatch<T> = { kind: 'default' } | { kind: 'values'; values: T[] };

export interface ServiceRef {
  id: number;
  country: string;
}

export type LibrarySelection =
  | { kind: 'overview' }
  | { kind: 'continue' }
  | { kind: 'history' }
  | { kind: 'title'; title: TitleRef }
  | { kind: 'presence'; titles: TitleRef[] }
  | { kind: 'settings' }
  | { kind: 'downloads' };

export interface LibraryOverviewView {
  kind: 'overview';
  owned: TitleRef[];
  watched: TitleRef[];
  watchlist: TitleRef[];
  standings: Array<{ title: TitleRef; standing: Standing }>;
  weighted: Array<{ title: TitleRef; weight: number; updatedAt: number }>;
  seeds: { watched: TitleRef[]; watchlisted: TitleRef[] };
}

export interface ContinueItem {
  title: TitleRef;
  fraction: number;
  episode?: { season: number; episode: number };
  seconds?: number;
  updatedAt?: number;
}

export interface ContinueView {
  kind: 'continue';
  items: ContinueItem[];
  /** Series whose exact Continue decision needs a title-shape observation. */
  needsShapes: TitleRef[];
}

export interface HistoryItem {
  title: TitleRef;
  /** Most recent known watch time in epoch milliseconds, or 0 for an undated import. */
  watchedAt: number;
  /** Latest watched episode for a series. */
  episode?: { season: number; episode: number };
  /** Number of watched episodes currently represented by the library. */
  episodes: number;
}

export interface HistoryView {
  kind: 'history';
  items: HistoryItem[];
}

export interface TitleView {
  kind: 'title';
  title: TitleRef;
  listed: boolean;
  watched: boolean;
  reaction: Reaction | null;
  standing: Standing | null;
  progress: { fraction: number; seconds?: number; updatedAt?: number } | null;
  episodes: Array<{
    season: number;
    episode: number;
    watched: boolean;
    fraction: number;
    seconds?: number;
    updatedAt?: number;
  }>;
}

export interface PresenceView {
  kind: 'presence';
  items: Array<{
    title: TitleRef;
    standing: Standing | null;
    reaction: Reaction | null;
  }>;
}

export interface SettingsView {
  kind: 'settings';
  preferences: LibraryPreferences;
}

/** Every preference synchronized in the library, projected with the same defaults as the settings screen. */
export interface LibraryPreferences {
  excludedGenres: number[];
  excludedLanguages: string[];
  hideAnime: boolean;
  hideWatched: boolean;
  minReleaseYear?: number;
  audioLanguage?: string;
  subtitleLanguage?: string;
  shownSubtitleLanguages: string[];
  subtitlesPerLanguage: number;
  autoSkipSegments: boolean;
  autoplayTrailers: boolean;
  ratingSources: RatingSource[];
  shownWarnings: string[];
  watchRegion?: string;
  services: ServiceRef[];
  servicesConfigured: boolean;
  maturityCeiling?: 'pg13' | 'r';
}

export interface DownloadViewItem {
  /** Stable domain key, not a settings-row name. */
  content: string;
  title: TitleRef;
  name: string;
  imdbId?: string;
  season?: number;
  episode?: number;
  posterPath?: string;
  stillPath?: string;
  queuedAt: number;
  queuedBy: { device: string; name?: string };
  release: Omit<DownloadReleaseDescriptor, 'url'>;
  alternate?: Omit<DownloadReleaseDescriptor, 'url'>;
  status: {
    state:
      | 'starting'
      | 'fetching'
      | 'not-started'
      | 'refused'
      | 'paused'
      | 'unreachable'
      | 'ready'
      | 'no-working-release'
      | 'release-gone';
    phase: 'queued' | 'downloading' | 'trouble' | 'ready';
    fraction?: number;
    service?: string;
    until?: number;
    stalled: boolean;
  };
  tried: number;
  candidates?: number;
  announced: boolean;
}

export interface DownloadsView {
  kind: 'downloads';
  items: DownloadViewItem[];
}

export type LibrarySelectionValue =
  | LibraryOverviewView
  | ContinueView
  | HistoryView
  | TitleView
  | PresenceView
  | SettingsView
  | DownloadsView;

export type LibraryQuery = {
  kind: 'playback.prepare';
  title: TitleRef;
  episode?: EpisodeRef;
};

export type LibraryQueryResult = {
  kind: 'playback.prepare';
  action: 'start' | 'resume' | 'next';
  target: (TitleRef & { type: 'movie' }) | EpisodeRef;
  resume: { fraction: number; seconds?: number } | null;
};

export type LibraryObservation =
  | {
      kind: 'title-shape';
      title: TitleRef & { type: 'tv' };
      seasons: Array<{ season: number; episodes: number }>;
      lastAired?: { season: number; episode: number };
    }
  | {
      kind: 'lifecycle';
      visible: boolean;
      online: boolean;
      playbackActive: boolean;
    };

interface ClientMessage {
  protocol: LibraryServiceProtocol;
}

export interface LibraryServiceHello extends ClientMessage {
  type: 'hello';
  requestId: string;
  clientId: string;
  libraryKey: string;
  mode: 'online' | 'local';
  /** One-time migration seed from the page's legacy localStorage clock. */
  legacyClock?: {
    device?: string;
    last?: [milliseconds: number, counter: number, device: string];
  };
}

export interface LibraryServiceCommandRequest extends ClientMessage {
  type: 'command';
  requestId: string;
  /** Stable across retries: durable action journals use it as their ID; every other command has set semantics. */
  operationId: string;
  command: LibraryCommand;
}

export interface LibraryServiceQueryRequest extends ClientMessage {
  type: 'query';
  requestId: string;
  query: LibraryQuery;
}

export interface LibraryServiceSubscribeRequest extends ClientMessage {
  type: 'subscribe';
  requestId: string;
  subscriptionId: string;
  selection: LibrarySelection;
}

export interface LibraryServiceUnsubscribeRequest extends ClientMessage {
  type: 'unsubscribe';
  requestId: string;
  subscriptionId: string;
}

export interface LibraryServiceObserveRequest extends ClientMessage {
  type: 'observe';
  requestId: string;
  observation: LibraryObservation;
}

export type LibraryServiceClientMessage =
  | LibraryServiceHello
  | LibraryServiceCommandRequest
  | LibraryServiceQueryRequest
  | LibraryServiceSubscribeRequest
  | LibraryServiceUnsubscribeRequest
  | LibraryServiceObserveRequest;

export type LibraryServiceErrorCode =
  | 'protocol-mismatch'
  | 'invalid-request'
  | 'not-ready'
  | 'conflict'
  | 'unauthorized'
  | 'not-found'
  | 'refused'
  | 'read-only'
  | 'moved'
  | 'storage'
  | 'unavailable'
  | 'cancelled'
  | 'internal';

export interface LibraryServiceFailure {
  code: LibraryServiceErrorCode;
  message: string;
  retryable: boolean;
  expectedProtocol?: number;
}

interface ServerMessage {
  protocol: LibraryServiceProtocol;
}

export interface LibraryServiceReady extends ServerMessage {
  type: 'ready';
  requestId: string;
  version: LibraryVersion;
}

export interface LibraryServiceCommandResult extends ServerMessage {
  type: 'command-result';
  requestId: string;
  operationId: string;
  outcome: 'applied' | 'unchanged';
  delivery: 'synced' | 'queued' | 'local';
  /** Emitted only after every affected subscription update for this revision. */
  version: LibraryVersion;
}

export interface LibraryServiceQueryResult extends ServerMessage {
  type: 'query-result';
  requestId: string;
  result: LibraryQueryResult;
  version: LibraryVersion;
}

export interface LibraryServiceSubscribed extends ServerMessage {
  type: 'subscribed';
  /** Emitted only after this subscription's initial replacement. */
  requestId: string;
  subscriptionId: string;
  version: LibraryVersion;
}

export interface LibraryServiceUnsubscribed extends ServerMessage {
  type: 'unsubscribed';
  requestId: string;
  subscriptionId: string;
}

export interface LibraryServiceObserved extends ServerMessage {
  type: 'observed';
  requestId: string;
  version: LibraryVersion;
}

export type LibrarySessionStatus =
  | { kind: 'ready'; version: LibraryVersion }
  | { kind: 'reconnecting'; version: LibraryVersion | null }
  | { kind: 'read-only'; version: LibraryVersion; reason: string }
  | { kind: 'moved'; successor?: string }
  | { kind: 'failed'; error: LibraryServiceFailure };

export interface LibraryServiceStatus extends ServerMessage {
  type: 'status';
  status: LibrarySessionStatus;
}

/** Replacements are intentional: one immutable assignment is one UI invalidation. */
export interface LibraryServiceUpdate extends ServerMessage {
  type: 'update';
  subscriptionId: string;
  version: LibraryVersion;
  value: LibrarySelectionValue;
}

export interface LibraryServiceError extends ServerMessage {
  type: 'error';
  requestId?: string;
  subscriptionId?: string;
  error: LibraryServiceFailure;
}

export type LibraryServiceServerMessage =
  | LibraryServiceReady
  | LibraryServiceCommandResult
  | LibraryServiceQueryResult
  | LibraryServiceSubscribed
  | LibraryServiceUnsubscribed
  | LibraryServiceObserved
  | LibraryServiceStatus
  | LibraryServiceUpdate
  | LibraryServiceError;
