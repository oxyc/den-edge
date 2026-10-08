/**
 * Transport-independent messages for the single library authority.
 *
 * This module deliberately describes domain intent and render-facing views. Durable log rows, stamps and the
 * implementation that projects them are private to the service.
 */

export const LIBRARY_SERVICE_PROTOCOL = 1 as const;

export type LibraryServiceProtocol = typeof LIBRARY_SERVICE_PROTOCOL;
export type MediaType = 'movie' | 'tv';
export type Reaction = 'seen' | 'dislike' | 'like' | 'love';
export type Standing = 'watchlist' | 'in-progress' | 'watched';

export interface TitleRef {
  type: MediaType;
  id: number;
}

export interface EpisodeRef extends TitleRef {
  type: 'tv';
  season: number;
  episode: number;
}

/** A monotonic version within one service instance and one durable library generation. */
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
  | { kind: 'preferences.patch'; patch: LibraryPreferencesPatch };

export interface LibraryPreferencesPatch {
  excludedGenres?: number[];
  excludedLanguages?: string[];
  hideAnime?: boolean;
  hideWatched?: boolean;
  minReleaseYear?: number | null;
  services?: ServiceRef[];
}

export interface ServiceRef {
  id: number;
  country: string;
}

export type LibrarySelection =
  | { kind: 'overview' }
  | { kind: 'continue' }
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
  preferences: {
    excludedGenres: number[];
    excludedLanguages: string[];
    hideAnime: boolean;
    hideWatched: boolean;
    minReleaseYear?: number;
    services: ServiceRef[];
    servicesConfigured: boolean;
  };
}

export interface DownloadViewItem {
  content: string;
  title: TitleRef;
  season?: number;
  episode?: number;
  state: 'queued' | 'preparing' | 'downloading' | 'complete' | 'failed';
  fraction?: number;
}

export interface DownloadsView {
  kind: 'downloads';
  items: DownloadViewItem[];
}

export type LibrarySelectionValue =
  LibraryOverviewView | ContinueView | TitleView | PresenceView | SettingsView | DownloadsView;

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
}

export interface LibraryServiceCommandRequest extends ClientMessage {
  type: 'command';
  requestId: string;
  /** Stable across a retry after a service crash, so applying a command is idempotent. */
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
