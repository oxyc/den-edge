/**
 * Transport-independent messages for the single library authority.
 *
 * This module deliberately describes domain intent and render-facing views. Durable log rows, stamps and the
 * implementation that projects them are private to the service.
 */

export const LIBRARY_SERVICE_PROTOCOL = 2 as const;

/** Memory-safety limits for one decoded wire message, not limits on what a library may contain. */
export const LIBRARY_SERVICE_WIRE_LIMITS = {
  collectionItems: 100_000,
  importItems: 100_000,
  presenceTitles: 512,
  shapeSeasons: 256,
  seasonEpisodes: 2_048,
  retainedTitles: 64,
  routeServices: 64,
  routeEntries: 32,
} as const;

export type LibraryServiceProtocol = typeof LIBRARY_SERVICE_PROTOCOL;
export type MediaType = 'movie' | 'tv';
export type Reaction = 'seen' | 'dislike' | 'like' | 'love';
export type Standing = 'watchlist' | 'in-progress' | 'watched';
export type RatingSource = 'imdb' | 'tmdb' | 'rottenTomatoes' | 'metacritic';
export type LibraryApiKeyService = 'tmdb' | 'omdb' | 'content-warnings';
export type MediaServerKind = 'jellyfin' | 'plex';

export interface TitleRef {
  type: MediaType;
  id: number;
}

export interface EpisodeRef extends TitleRef {
  type: 'tv';
  season: number;
  episode: number;
}

export interface RuntimeDiscoveryView {
  kind: 'runtime';
  /** Explicit temporary capabilities for page-owned metadata fetches; remove with that subsystem's cutover. */
  tmdbKey: string;
  providerKeys: Partial<Record<LibraryApiKeyService, string>>;
  pluginManifestUrls: string[];
  privateRemuxUrl: string | null;
}

export interface RetainedRouteEntry {
  url: string;
  access?: boolean;
}

export type RetainedRoutes = Record<string, RetainedRouteEntry[]>;

export interface RetainedAddon {
  install: string;
  base: string;
}

export interface RetainedServices {
  routes: RetainedRoutes;
  scout: RetainedAddon | null;
  atlas: string | null;
  reel: string | null;
  remux: string | null;
}

export interface RetainedRecommendationWhy {
  score?: number;
  fit?: number;
  similar?: number | null;
  profile?: number;
  people?: number;
  confidence?: number;
  fresh?: number;
  arrived?: number;
  quality?: number;
  buzz?: number;
  reason?: string;
}

/** The bounded display title Home already retains for a future billboard first paint. */
export interface RetainedBillboardTitle extends TitleRef {
  title: string;
  posterPath?: string;
  posterUrl?: string;
  backdropPath?: string;
  year?: number;
  releaseDate?: string;
  rating?: number;
  ratingSource?: 'tmdb' | 'justwatch-imdb';
  votes?: number;
  popularity?: number;
  countries?: string[];
  people?: number[];
  collectionId?: number;
  genreIds?: number[];
  primaryGenreName?: string;
  likely?: boolean;
  originalLanguage?: string;
  adult?: boolean;
  imdbId?: string;
  arrivesAt?: number;
  services?: string[];
  why?: RetainedRecommendationWhy;
}

export type RetainedBillboardScope =
  | { kind: 'shared'; facet: MediaType | null; fresh: boolean }
  | { kind: 'personal'; facet: MediaType | null; fresh: boolean };

export type RetainedBillboard =
  | { kind: 'shared'; titles: RetainedBillboardTitle[] }
  | { kind: 'personal'; at: number; titles: RetainedBillboardTitle[] };

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
  sizeBytes?: number;
  cached?: boolean;
}

/** A release choice safe to render. Playback tickets remain inside the service. */
export type DownloadReleaseOption = DownloadReleaseDescriptor;

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
      kind: 'api-key.set';
      service: LibraryApiKeyService;
      value: string | null;
    }
  | { kind: 'parental-pin.set'; pin: string | null }
  | {
      kind: 'remote-access.set';
      credentials: { clientId: string; clientSecret: string } | null;
    }
  | { kind: 'plugin.install'; manifestUrl: string }
  | { kind: 'plugin.remove'; manifestUrl: string }
  | { kind: 'plugin-trust.set'; manifestUrl: string; publicKey: string | null }
  | {
      kind: 'server.patch';
      server: MediaServerKind;
      value: { url: string; user?: string; credential?: string } | null;
    }
  | { kind: 'device.heartbeat'; name: string }
  | { kind: 'device.remove'; deviceId: string }
  | { kind: 'simkl.connect'; token: string }
  | { kind: 'simkl.disconnect' }
  | { kind: 'simkl.removals.approve'; approvalId: string }
  | { kind: 'discovery.remux.remember'; url: string }
  | { kind: 'retained.services.set'; value: RetainedServices }
  | { kind: 'retained.home-continue.set'; present: boolean }
  | {
      kind: 'retained.billboard.set';
      scope: RetainedBillboardScope;
      value: RetainedBillboard;
    }
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
      identity: string;
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
  | { kind: 'connections' }
  | { kind: 'simkl' }
  | { kind: 'recovery' }
  | { kind: 'runtime' }
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
  /** Exact watched episodes, retained only in the lazy history view. */
  seen?: Array<{ season: number; episode: number }>;
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

export interface LibraryDeviceView {
  id: string;
  name: string;
  kind: 'tv' | 'browser';
  lastSeenAt?: number;
  libraryFormat?: number;
}

export interface LibraryPluginView {
  manifestUrl: string;
  signingKey?: string;
  pendingApprovalOn: Array<{ id: string; name: string }>;
}

/** Settings-facing connection state with storage names, stamps, and ConfigValue deliberately erased. */
export interface ConnectionsView {
  kind: 'connections';
  apiKeys: Partial<Record<LibraryApiKeyService, { configured: true; masked: string }>>;
  parentalPinConfigured: boolean;
  remoteAccessConfigured: boolean;
  plugins: LibraryPluginView[];
  servers: Array<{ kind: MediaServerKind; url: string; user?: string }>;
  devices: LibraryDeviceView[];
  diagnostics: {
    libraryFormat: number;
    pendingChanges: number;
    selfDeviceId: string;
  };
}

/** Tracker state needed by Settings. Credentials, delivery rows and approval stamps stay in the service. */
export interface SimklView {
  kind: 'simkl';
  connected: boolean;
  account?: string;
  heldRemovals: TitleRef[];
  /** Opaque identity for exactly the currently shown removal batch. */
  approvalId?: string;
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
  queuedBy: { device: string; name?: string; isSelf: boolean };
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
    progressAt?: number;
    etaSeconds?: number;
    bytesPerSecond?: number;
    fetch?: {
      state?: 'queued' | 'fetching' | 'downloading' | 'stalled' | 'failed';
      seeds?: number;
      peers?: number;
      service?: string;
    };
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

/** Recovery state is reconciled by the authority; locators and sealed keys never become page model state. */
export interface RecoveryView {
  kind: 'recovery';
  availability: 'ready' | 'waits';
  live: {
    createdAt: number;
    by: string;
    byName: string;
    opens: number;
    lastOpenedAt: number | null;
    reposted: boolean;
  } | null;
  broken: boolean;
  notices: string[];
}

export type LibrarySelectionValue =
  | LibraryOverviewView
  | ContinueView
  | HistoryView
  | TitleView
  | PresenceView
  | SettingsView
  | ConnectionsView
  | SimklView
  | RecoveryView
  | RuntimeDiscoveryView
  | DownloadsView;

export interface HistoryImportItem {
  title: TitleRef;
  /** A provider import has one authoritative most-recent film viewing. */
  watchedAt?: number;
  episodes?: Array<{ season: number; episode: number; watchedAt: number }>;
  /** The provider export covered every aired episode known by its matching pass. */
  complete?: boolean;
}

export type LibraryTask =
  | { kind: 'recovery.begin'; locator: string; sealed: string; createdAt: number }
  | { kind: 'recovery.confirm'; locator: string }
  | { kind: 'recovery.abandon'; locator: string }
  | { kind: 'recovery.disable' }
  | { kind: 'history.import'; items: HistoryImportItem[] }
  | { kind: 'local-library.merge'; sourceLibraryKey: string }
  | { kind: 'key-reset.move'; destinationLibraryKey: string }
  | { kind: 'key-reset.settle'; destinationLibraryKey: string }
  | { kind: 'key-reset.adopt'; destinationLibraryKey: string };

export type KeyResetOutcome =
  | 'moved'
  | 'adopted'
  | 'undone'
  | 'held'
  | 'foreign'
  | 'unknown'
  | 'update-required'
  | 'unavailable';

export type LibraryTaskResult =
  | { kind: 'recovery.begin'; outcome: 'begun' | 'full' | 'taken' | 'waits' | 'failed' }
  | { kind: 'recovery.confirm'; outcome: 'confirmed' | 'lost' | 'failed' }
  | { kind: 'recovery.abandon'; outcome: 'abandoned' }
  | { kind: 'recovery.disable'; outcome: 'disabled' }
  | { kind: 'history.import'; written: number; total: number; complete: boolean }
  | { kind: 'local-library.merge'; outcome: 'merged' | 'unavailable' }
  | { kind: 'key-reset.move' | 'key-reset.settle' | 'key-reset.adopt'; outcome: KeyResetOutcome };

export type LibraryQuery =
  | {
      kind: 'playback.prepare';
      title: TitleRef;
      episode?: EpisodeRef;
    }
  | { kind: 'parental-pin.verify'; pin: string }
  | { kind: 'key-reset.prepare' }
  | {
      kind: 'recovery.seal';
      locator: string;
      wrapKey: string;
      createdAt: number;
    }
  | {
      kind: 'pairing.handover';
      handoverKey: string;
      host: string;
      linkKey?: string;
    }
  | { kind: 'history.export' }
  | { kind: 'relay.membership' }
  | { kind: 'download.refresh'; target?: DownloadTarget }
  | { kind: 'download.releases'; title: DownloadTitleDescriptor }
  | { kind: 'retained.services.get' }
  | { kind: 'retained.home-continue.get' }
  | { kind: 'retained.billboard.get'; scope: RetainedBillboardScope };

export type LibraryQueryResult =
  | {
      kind: 'playback.prepare';
      action: 'start' | 'resume' | 'next';
      target: (TitleRef & { type: 'movie' }) | EpisodeRef;
      resume: { fraction: number; seconds?: number } | null;
    }
  | { kind: 'parental-pin.verify'; matches: boolean }
  | { kind: 'key-reset.prepare'; destinationLibraryKey: string; device: string }
  | { kind: 'recovery.seal'; sealed: string }
  | { kind: 'pairing.handover'; sealed: string; linkKey: string; inboxKey: string }
  | {
      kind: 'history.export';
      exportedAt: string;
      titles: Array<{
        type: MediaType;
        tmdbId: number;
        status: 'none' | 'watchlist' | 'inProgress' | 'watched';
        reaction: Reaction | null;
        addedAt: string | null;
        plays?: Array<{ watchedAt: string | null; rewatch: boolean; source: 'den' | 'import' }>;
        episodes?: Array<{
          season: number;
          episode: number;
          plays: Array<{ watchedAt: string | null; rewatch: boolean; source: 'den' | 'import' }>;
        }>;
      }>;
    }
  | {
      kind: 'relay.membership';
      /** Derived relay-only authority. It cannot decrypt, read, or write the library. */
      capability: { libraryId: string; memberToken: string } | null;
    }
  | { kind: 'download.refresh'; refreshed: boolean }
  | { kind: 'download.releases'; releases: DownloadReleaseOption[] | null }
  | { kind: 'retained.services'; value: RetainedServices | null }
  | { kind: 'retained.home-continue'; present: boolean | null }
  | {
      kind: 'retained.billboard';
      scope: RetainedBillboardScope;
      value: RetainedBillboard | null;
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
    }
  /** One-way session milestone: optional provider/download work may now use the network. */
  | { kind: 'foreground-ready' };

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

export interface LibraryServiceTaskRequest extends ClientMessage {
  type: 'task';
  requestId: string;
  operationId: string;
  task: LibraryTask;
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
  | LibraryServiceTaskRequest
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

export interface LibraryServiceTaskResult extends ServerMessage {
  type: 'task-result';
  requestId: string;
  operationId: string;
  result: LibraryTaskResult;
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
  | LibraryServiceTaskResult
  | LibraryServiceSubscribed
  | LibraryServiceUnsubscribed
  | LibraryServiceObserved
  | LibraryServiceStatus
  | LibraryServiceUpdate
  | LibraryServiceError;
