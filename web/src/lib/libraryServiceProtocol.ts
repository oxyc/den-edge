/**
 * Transport-independent messages for the single library authority.
 *
 * This module deliberately describes domain intent and render-facing views. Durable log rows, stamps and the
 * implementation that projects them are private to the service.
 */

/** Version 8 adds the small, independently subscribable device view used by playback surfaces. */
export const LIBRARY_SERVICE_PROTOCOL = 8 as const;

/** Memory-safety limits for one decoded wire message, not limits on what a library may contain. */
export const LIBRARY_SERVICE_WIRE_LIMITS = {
  collectionItems: 100_000,
  importItems: 100_000,
  presenceTitles: 512,
  shapeSeasons: 256,
  seasonEpisodes: 2_048,
  downloadSources: 512,
  retainedTitles: 64,
  routeServices: 64,
  routeEntries: 32,
  libraryMetadataTitles: 512,
  profileEntries: 64,
} as const;

export type LibraryServiceProtocol = typeof LIBRARY_SERVICE_PROTOCOL;
/** Library-v4 rows use wire 4. A profile-aware configuration-only household uses wire 5. */
export type LibraryWire = 4 | 5;
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

/** TMDB display fields returned only for the library's bounded naming pass. */
export interface LibraryMetadataTitle extends TitleRef {
  title: string;
  posterPath?: string;
  backdropPath?: string;
  year?: number;
  releaseDate?: string;
  rating?: number;
  ratingSource?: 'tmdb';
  votes?: number;
  popularity?: number;
  countries?: string[];
  people?: number[];
  collectionId?: number;
  genreIds?: number[];
  originalLanguage?: string;
  adult?: boolean;
  imdbId?: string;
}

export interface LibraryMetadataShape {
  title: TitleRef & { type: 'tv' };
  seasons: Array<{ season: number; episodes: number }>;
  lastAired?: { season: number; episode: number };
}

export interface EpisodeRef extends TitleRef {
  type: 'tv';
  season: number;
  episode: number;
}

export interface RuntimeDiscoveryView {
  kind: 'runtime';
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
  /** When an episode airs (ms). A wanted download of one not yet out searches from then. */
  airDate?: number;
}

/** One source release. Its URL is a play-ticket capability, not a durable-row or transport concern. */
export interface DownloadReleaseDescriptor {
  identity: string;
  label: string;
  sizeBytes?: number;
  cached?: boolean;
}

/** A ranked source safe to render. Playback tickets and provider attributes remain inside the service. */
export interface DownloadSourceOption extends DownloadReleaseDescriptor {
  filename: string;
  seeders?: number;
  packSizeBytes?: number;
  badges: string[];
  languages: string[];
  probed: boolean;
}

export interface DownloadSourceAnswer {
  kind: 'live' | 'partial' | 'empty' | 'unknown' | 'stale';
  missing: number;
  outageBuiltAt?: number;
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
  /**
   * profiles-v1 §6.3: give this profile library the preferences an older household still holds that it has not
   * decided itself. `household` is the household's stored `set:prefs` values (`preferences.raw`).
   */
  | { kind: 'preferences.seed'; household: StoredPreferenceValues }
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
  | { kind: 'device.heartbeat'; name: string; deviceKind?: 'tv' | 'browser' }
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
  /**
   * Content asked for with nothing to fetch yet (an episode a season download found no release for, or not aired):
   * kept as a download that is searched for again until a release turns up.
   */
  | { kind: 'download.want'; title: DownloadTitleDescriptor }
  | { kind: 'download.remove'; target: DownloadTarget }
  | {
      /** Preserve the current partial release and try this release beside it. */
      kind: 'download.release.try';
      target: DownloadTarget;
      identity: string;
    };

/** A `set:prefs` row's `values`: each key's stamped value (`{value, at}` plus any members this client does not know). */
export type StoredPreferenceValues = Record<string, object>;

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
  | { kind: 'watchlist' }
  | { kind: 'recommendations' }
  | { kind: 'continue' }
  | { kind: 'history' }
  | { kind: 'title'; title: TitleRef }
  | { kind: 'presence'; titles: TitleRef[] }
  | { kind: 'settings' }
  | { kind: 'devices' }
  | { kind: 'connections' }
  | { kind: 'simkl' }
  | { kind: 'recovery' }
  | { kind: 'runtime' }
  | { kind: 'profiles' }
  | { kind: 'downloads' };

export interface ProfileDirectoryView {
  kind: 'profiles';
  /**
   * `absent`: no profiles row and no committed split, so a legacy household or a browser-local library. `invalid`: a
   * row exists but cannot be opened, or the household's wire minimum shows a split was committed. Never open Owner.
   * `pending`: a split was committed but this browser has yet to read the household it produced.
   */
  state: 'absent' | 'invalid' | 'present' | 'pending';
  owner: string | null;
  profiles: Array<{
    id: string;
    role: 'owner' | 'kid' | 'adult';
    name: string;
    avatar?: string;
    libraryKey: string;
    keyVersion: number;
    policy: { maximumAge: number | null; unknownRatings: 'allow' | 'block' };
    /** Effective allow entries from this Kid's validated household approval document. */
    approvals?: TitleRef[];
    deleted: boolean;
  }>;
}

export interface LibraryOverviewView {
  kind: 'overview';
  owned: TitleRef[];
  watched: TitleRef[];
  watchlist: TitleRef[];
  standings: Array<{ title: TitleRef; standing: Standing }>;
  weighted: Array<{ title: TitleRef; weight: number; updatedAt: number }>;
  seeds: { watched: TitleRef[]; watchlisted: TitleRef[] };
}

/** Small independent shelf selection for clients that do not need watched recommendation inputs. */
export interface WatchlistView {
  kind: 'watchlist';
  titles: TitleRef[];
}

/** Recommendation inputs without the Watchlist shelf payload. */
export interface RecommendationInputsView {
  kind: 'recommendations';
  owned: TitleRef[];
  watched: TitleRef[];
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
  /** The episode and fraction supplying `seconds`, when the resume target above is already another episode. */
  liveEpisode?: { season: number; episode: number };
  liveFraction?: number;
  /** The name the device that wrote `seconds` gives itself in `set:devices`. */
  device?: string;
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
  /**
   * What an open page owes assistants (den-spec assistant v1): a live grant to write means draining its queue, a live
   * read record means publishing a projection. Both false, as for nearly every library, and the page runs nothing.
   */
  assistant: AssistantNeeds;
}

export interface AssistantNeeds {
  write: boolean;
  read: boolean;
}

export interface LibraryDeviceView {
  id: string;
  name: string;
  kind: 'tv' | 'browser';
  lastSeenAt?: number;
  libraryFormat?: number;
}

/** Playback-facing devices, separate from Settings' credentials, plugins, servers and diagnostics. */
export interface DevicesView {
  kind: 'devices';
  devices: LibraryDeviceView[];
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
  /** `queued` means the shown PIN is only a durable local projection and cannot authorize security actions yet. */
  parentalPinDelivery: 'synced' | 'queued' | 'local';
  remoteAccessConfigured: boolean;
  plugins: LibraryPluginView[];
  servers: Array<{ kind: MediaServerKind; url: string; user?: string }>;
  devices: LibraryDeviceView[];
  diagnostics: {
    libraryFormat: number;
    pendingChanges: number;
    selfDeviceId: string;
    /** A valid or invalid `set:profiles` row exists, so only the compound profile reset may rotate keys. */
    profileTopology?: boolean;
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
  /** Absent while nothing was found to fetch yet (a wanted episode, searched for again at `status.until`). */
  release?: Omit<DownloadReleaseDescriptor, 'url'>;
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
      | 'awaiting-air'
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
  | WatchlistView
  | RecommendationInputsView
  | ContinueView
  | HistoryView
  | TitleView
  | PresenceView
  | SettingsView
  | DevicesView
  | ConnectionsView
  | SimklView
  | RecoveryView
  | RuntimeDiscoveryView
  | ProfileDirectoryView
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
  /**
   * A library kept only in this browser written into this one. `scope` takes only the household half or only the
   * profile half of its rows; `keep` leaves the source in place for the other half to be taken from it. `verify` reads
   * this library back from den-edge afterwards and answers `unverified` unless it holds everything that was written.
   */
  | {
      kind: 'local-library.merge';
      sourceLibraryKey: string;
      scope?: 'household' | 'profile';
      keep?: true;
      verify?: true;
    }
  /**
   * Start, or finish, the household `householdKey` that a browser with no TV makes on its first kept action (den#295):
   * born at wire minimum 5 with an Owner library and the directory a committed Owner split stores. Idempotent on its
   * inputs, which the page keeps before it asks. `ifKept` starts nothing (`empty`) while the library kept here holds
   * nothing a person kept: a browser that kept a library before households is moved on load, one that only browsed is not.
   */
  | {
      kind: 'household.create';
      householdKey: string;
      attempt: string;
      ownerProfile: string;
      ownerKey: string;
      createdAt: number;
      ifKept?: true;
    }
  /** The household's Kid, made once when its directory has none: no Owner PIN is asked, since none may exist yet. */
  | { kind: 'profile.create-default' }
  /**
   * This browser's own household `sourceLibraryKey` joins this one (den#295): its Owner's and Kids' activity merge in,
   * then it is retired. `pin` is this household's Owner PIN, asked once when it has one.
   */
  | { kind: 'household.join'; sourceLibraryKey: string; pin?: string }
  | { kind: 'key-reset.move'; destinationLibraryKey: string }
  | { kind: 'key-reset.settle'; destinationLibraryKey: string }
  | { kind: 'key-reset.adopt'; destinationLibraryKey: string }
  /**
   * A member allows an assistant to change the library, read it, or both: its grant row and read record are written,
   * its keys returned once.
   */
  | { kind: 'assistant.consent'; client: string; write: boolean; read: boolean }
  | { kind: 'assistant.revoke'; grant: string }
  /**
   * Build every live read grant's projection and send what is due (§15). `connection`: a split household's, which
   * Owner's library publishes its lists for.
   */
  | { kind: 'assistant.publish'; connection?: AssistantConnection }
  /** The grants whose connection den-edge still lists, kept from expiring (at most daily). */
  | { kind: 'assistant.renew'; grants: string[] }
  /**
   * A drain of den-edge's assistant queue, opened, checked and applied in `seq` order. `connection`: a split
   * household's, whose queue it is; Owner's library applies it.
   */
  | {
      kind: 'assistant.apply';
      messages: Array<{ seq: number; sealed: string }>;
      connection?: AssistantConnection;
    }
  | {
      kind: 'profile-migration.enable';
      attempt: string;
      source: { generation: number; head: string };
    }
  | { kind: 'profile-migration.cancel'; attempt: string }
  | {
      kind: 'profile-migration.recover';
      /** The restore-required split journal on this device, or null for the journal-less Owner Restore. */
      attempt: string | null;
      recoveryAttempt: string;
      source: { generation: number; head: string };
    }
  | { kind: 'profile.create'; name: string; maximumAge: number; pin: string }
  | { kind: 'profile.create.ack'; receipt: string }
  /**
   * Change a Kid's content policy (profiles-v1 §5): an owner-authorized write to the directory, authorized by the
   * Owner PIN like creating one. `maximumAge: null` is no age limit.
   */
  | {
      kind: 'profile.policy.set';
      profile: string;
      maximumAge: number | null;
      unknownRatings: 'allow' | 'block';
      pin: string;
    }
  | {
      kind: 'kid-title-approval.set';
      profile: string;
      title: TitleRef;
      allow: boolean;
      pin: string;
    }
  /** The compound key reset (profiles-v1 §9) of a profile household, behind a fresh Owner PIN. */
  | { kind: 'profile-key-reset.start'; pin: string; destinationLibraryKey: string }
  /** Continue the journaled attempt on this device; the journal already holds the authorization. */
  | { kind: 'profile-key-reset.resume' }
  /**
   * The page installed the successor household key and read it back. Only then does the worker erase the journal,
   * which holds the last copy of every old and provisional credential.
   */
  | { kind: 'profile-key-reset.confirm'; destinationLibraryKey: string }
  /** Journal-less recovery (§9.1) as the recovery attempt `recoveryAttempt`; `successorKey` only if this browser holds it. */
  | {
      kind: 'profile-key-reset.recover';
      pin: string;
      recoveryAttempt: string;
      successorKey: string | null;
    };

/**
 * A household's assistant connection, lent by its library service to Owner's on a household split into profiles
 * (assistant-v1 §15, profiles-v1 §4 and §6.1): the member proof of the library the connection was made for, its
 * connection rows (`set:assistant`, `-grants`, `-read`, `-play`) as the household's service read them, and the grants
 * the household's records hold revoked on this device. The page passes it on and reads none of it.
 */
export interface AssistantConnection {
  member: { libraryId: string; memberToken: string };
  rows: Array<{ kind: 'set'; schema: number; name: string; values: StoredPreferenceValues }>;
  revoked: string[];
}

/** A grant as the library's grants row holds it (`assistant_grants`), for Settings. */
export interface AssistantGrantView {
  grant: string;
  client?: string;
  ops?: string[];
  cap?: number;
  createdAt?: number;
  expiresAt?: number;
  revokedAt?: number | null;
  state: 'active' | 'expired' | 'revoked' | 'newer' | 'malformed';
}

/** One drained assistant request, as the library service handled it. */
export type AssistantApplied =
  | {
      seq: number;
      outcome: 'accepted';
      op: 'watchlist_add' | 'watchlist_remove' | 'seen' | 'rate';
      title: TitleRef;
      /** What it did, in the words of the page's toast: "added to your watchlist". */
      detail: string;
    }
  | { seq: number; outcome: 'rejected'; reason: string };

export type KeyResetOutcome =
  | 'moved'
  | 'adopted'
  | 'undone'
  | 'held'
  | 'foreign'
  | 'unknown'
  | 'update-required'
  | 'profiles-active'
  | 'unavailable';

export type LibraryTaskResult =
  | { kind: 'recovery.begin'; outcome: 'begun' | 'full' | 'taken' | 'waits' | 'failed' }
  | { kind: 'recovery.confirm'; outcome: 'confirmed' | 'lost' | 'failed' }
  | { kind: 'recovery.abandon'; outcome: 'abandoned' }
  | { kind: 'recovery.disable'; outcome: 'disabled' }
  | { kind: 'history.import'; written: number; total: number; complete: boolean }
  | {
      kind: 'local-library.merge';
      /** `unverified`: written, but den-edge's copy read back lacks some of it. `retryAfterMs`: den-edge asked to wait. */
      outcome: 'merged' | 'absent' | 'unavailable' | 'unverified';
      retryAfterMs?: number;
      /** With `verify`, merged: how many live rows den-edge held when it was read back. */
      held?: number;
    }
  | {
      kind: 'household.create';
      /**
       * `refused`: den-edge starts no library for this browser (`403 new_libraries_closed`); `throttled`: not now, try
       * again after `retryAfterMs`; `unavailable`: anything else, to be tried again with the same inputs; `empty`:
       * `ifKept` and nothing is kept here, so nothing was asked.
       */
      outcome: 'created' | 'refused' | 'throttled' | 'unavailable' | 'empty';
      retryAfterMs?: number;
    }
  | { kind: 'profile.create-default'; outcome: 'created' | 'present' }
  | {
      kind: 'household.join';
      /**
       * `joined`: everything carried and the source retired; `owner` is this household's Owner and `kids` the Kid each
       * source Kid became (both empty for a household without profiles). `pin-required`/`pin-wrong`: ask for the
       * Owner PIN. `refused-kids`: this household has no profiles and a source Kid has activity. Nothing is lost on
       * any answer but `joined`; the same task finishes it later.
       */
      outcome: 'joined' | 'pin-required' | 'pin-wrong' | 'refused-kids' | 'unavailable';
      owner?: string | null;
      kids?: Record<string, string>;
    }
  | { kind: 'key-reset.move' | 'key-reset.settle' | 'key-reset.adopt'; outcome: KeyResetOutcome }
  | { kind: 'assistant.consent'; grant: string; key: string; readKey?: string }
  | { kind: 'assistant.revoke'; outcome: 'revoked' | 'absent' }
  | { kind: 'assistant.publish'; published: number }
  | { kind: 'assistant.renew'; renewed: number }
  | {
      kind: 'assistant.apply';
      results: AssistantApplied[];
      /** The highest `seq` den-edge may drop, or null when none of these may be. */
      ack: number | null;
      /** The drop-box public key den-edge should hold, or null when the library has none. */
      dropbox: { kid: string; public: string } | null;
    }
  | {
      kind: 'profile-migration.enable' | 'profile-migration.cancel' | 'profile-migration.recover';
      outcome:
        | 'preparing'
        | 'reconciling'
        | 'enabled'
        | 'recovery-required'
        | 'source-changed'
        /** den-core refused the source before anything was staged; the attempt was aborted and the lock released. */
        | 'source-refused'
        /** `409 migration_in_progress`: another attempt holds the household lock; nothing was changed. */
        | 'setup-in-progress'
        | 'cancelled';
      attempt?: string;
    }
  | {
      kind: 'profile.create';
      outcome: 'created';
      profile: string;
      name: string;
      maximumAge: number;
      receipt: string;
    }
  | { kind: 'profile.create.ack'; outcome: 'acknowledged' }
  | { kind: 'profile.policy.set'; outcome: 'changed' | 'unchanged' }
  | { kind: 'kid-title-approval.set'; outcome: 'changed' | 'unchanged' }
  | {
      kind:
        | 'profile-key-reset.start'
        | 'profile-key-reset.resume'
        | 'profile-key-reset.confirm'
        | 'profile-key-reset.recover';
      outcome: ProfileKeyResetOutcome;
    };

export type ProfileKeyResetOutcome =
  /** Every old library is retired and the page may install the successor household key (`confirm` follows). */
  | 'install'
  /** The page installed the successor, the worker read it back and erased its journal. */
  | 'complete'
  /** The locks were released or den-edge rolled the attempt back; nothing changed and the journal is gone. */
  | 'aborted'
  /** den-edge or another device is not ready; the journal stays and the reset resumes. */
  | 'waiting'
  /** `resume` found no journal on this device. */
  | 'none'
  /** Recovery finished retirement with proof of the successor key; the caller adopts it. */
  | 'retired'
  /** Recovery cannot proceed here: another device must finish the reset. */
  | 'blocked'
  /** Profile migration is off, or the household has no profile directory. */
  | 'unavailable';

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
      grantTicket?: string;
    }
  | { kind: 'history.export' }
  | { kind: 'relay.membership' }
  | { kind: 'download.refresh'; target?: DownloadTarget }
  | { kind: 'download.sources'; title: DownloadTitleDescriptor; refresh?: boolean }
  | { kind: 'download.artwork'; target: DownloadTarget }
  /** The stored `set:prefs` values with their stamps, as profile seeding takes them. */
  | { kind: 'preferences.raw' }
  | { kind: 'retained.services.get' }
  | { kind: 'retained.home-continue.get' }
  | { kind: 'retained.billboard.get'; scope: RetainedBillboardScope }
  | { kind: 'library.metadata'; titles: TitleRef[] }
  /** The grants the library's row holds, whatever their state, for Settings › Assistants. */
  | { kind: 'assistant.grants' }
  /** The household's assistant connection, to lend Owner's library on a household split into profiles. */
  | { kind: 'assistant.connection' }
  | { kind: 'profile-migration.status' }
  | { kind: 'profile-migration.observe' }
  | { kind: 'profile-migration.observe-recovery'; attempt: string | null }
  | { kind: 'profile-create.status' };

export type LibraryQueryResult =
  | {
      kind: 'playback.prepare';
      action: 'start' | 'resume' | 'next';
      target: (TitleRef & { type: 'movie' }) | EpisodeRef;
      resume: { fraction: number; seconds?: number } | null;
    }
  | {
      kind: 'library.metadata';
      titles: LibraryMetadataTitle[];
      shapes: LibraryMetadataShape[];
      /** Questions that failed transiently and are safe for the page to ask again. */
      retryable: TitleRef[];
      /** Longest provider-requested pause among `retryable`; absent for ordinary transient failures. */
      retryAfterMs?: number;
    }
  | { kind: 'parental-pin.verify'; matches: boolean }
  | {
      kind: 'profile-migration.status';
      phase:
        | 'off'
        | 'available'
        | 'preparing'
        | 'ready'
        | 'reconciling'
        | 'enabled'
        | 'recovery-required'
        | 'setup-in-progress';
      attempt?: string;
    }
  | {
      kind: 'profile-migration.observe';
      attempt: string;
      source: { generation: number; head: string };
    }
  | {
      kind: 'profile-migration.observe-recovery';
      attempt: string | null;
      recoveryAttempt: string;
      source: { generation: number; head: string };
    }
  | {
      kind: 'profile-create.status';
      phase: 'idle' | 'created';
      profile?: string;
      name?: string;
      maximumAge?: number;
      receipt?: string;
    }
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
  | {
      kind: 'download.sources';
      sources: DownloadSourceOption[] | null;
      answer?: DownloadSourceAnswer;
      failure?: 'not-configured' | 'unmatched' | 'unreachable';
    }
  | { kind: 'download.artwork'; stillPath: string | null }
  | { kind: 'preferences.raw'; values: StoredPreferenceValues }
  | { kind: 'retained.services'; value: RetainedServices | null }
  | { kind: 'retained.home-continue'; present: boolean | null }
  | {
      kind: 'retained.billboard';
      scope: RetainedBillboardScope;
      value: RetainedBillboard | null;
    }
  | {
      kind: 'assistant.grants';
      grants: AssistantGrantView[];
      reads: AssistantGrantView[];
      plays: AssistantGrantView[];
    }
  | { kind: 'assistant.connection'; connection: AssistantConnection | null };

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
  wire: LibraryWire;
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
  | 'update-required'
  | 'unavailable'
  | 'cancelled'
  | 'internal';

export interface LibraryServiceFailure {
  code: LibraryServiceErrorCode;
  message: string;
  retryable: boolean;
  expectedProtocol?: number;
  requiredWire?: number;
}

interface ServerMessage {
  protocol: LibraryServiceProtocol;
}

export interface LibraryServiceReady extends ServerMessage {
  type: 'ready';
  requestId: string;
  /** Installed by the page transport before any library snapshot becomes observable. */
  relayMembership: { libraryId: string; memberToken: string } | null;
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

/**
 * Sent while a hello is still open and the library is being read from den-edge for the first time: how far through
 * den-edge's history the read is, from 0 to 1. It also shows the open is alive, however long a big library takes.
 */
export interface LibraryServiceOpening extends ServerMessage {
  type: 'opening';
  requestId: string;
  progress: number;
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
  | LibraryServiceOpening
  | LibraryServiceUpdate
  | LibraryServiceError;
