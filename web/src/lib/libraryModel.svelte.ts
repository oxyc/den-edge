import { LibraryServiceError, type LibraryServiceOpenOptions } from './libraryServiceClient';
import { LIBRARY_SERVICE_WIRE_LIMITS } from './libraryServiceProtocol';
import type { SeenEpisode } from './history';
import type {
  AssistantConnection,
  ConnectionsView,
  ContinueView,
  DevicesView,
  DownloadReleaseDescriptor,
  DownloadTarget,
  DownloadTitleDescriptor,
  DownloadsView,
  EpisodeRef,
  HistoryView,
  HistoryImportItem,
  LibraryApiKeyService,
  LibraryCommand,
  LibraryObservation,
  LibraryMetadataTitle,
  LibraryMetadataShape,
  LibraryOverviewView,
  LibraryPreferencesPatch,
  StoredPreferenceValues,
  LibraryQuery,
  LibraryQueryResult,
  LibraryTask,
  LibraryTaskResult,
  LibraryServiceCommandResult,
  LibraryServiceFailure,
  LibrarySessionStatus,
  LibraryVersion,
  MediaServerKind,
  PresenceView,
  ProfileDirectoryView,
  Reaction,
  RecoveryView,
  RetainedBillboard,
  RetainedBillboardScope,
  RetainedServices,
  RuntimeDiscoveryView,
  SettingsView,
  SimklView,
  TitleRef,
  TitleView,
} from './libraryServiceProtocol';
import type { LibraryRelayMembership } from './relayFetch';
import { noteLibraryOpening } from './libraryOpening.svelte';
import type {
  LibrarySelectionConnection,
  LibrarySelectionSnapshot,
  LibraryServiceSupervisor,
} from './libraryServiceSupervisor';

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

/** How often, and how long each time, a refused read of kept Home state waits for the service before it asks again. */
const RETAINED_READ_ATTEMPTS = 4;
const RECONNECT_WAIT_MS = 2_000;
const RETAINED_READ_RETRY_MS = 50;

/** Render views are service-owned replacements. Page code can read them but must never edit them in place. */
export type Immutable<T> = T extends Primitive | ((...arguments_: never[]) => unknown)
  ? T
  : T extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : { readonly [Key in keyof T]: Immutable<T[Key]> };

export type LibraryModelConnection = LibrarySelectionConnection | 'closed';

export type LibraryModelStatus =
  { readonly kind: 'connecting' } | Immutable<LibrarySessionStatus> | { readonly kind: 'closed' };

/** One reactive replacement. A reconnect retains `value` and `version` while its connection changes. */
export interface LibraryModelSnapshot<View> {
  readonly connection: LibraryModelConnection;
  readonly value?: Immutable<View>;
  readonly version?: Immutable<LibraryVersion>;
  readonly error?: Immutable<LibraryServiceFailure>;
}

/**
 * A page-owned reference to a keyed service selection. Release it with the page/component lifecycle. Multiple
 * leases for the same exact key share one service subscription until the last lease is released.
 */
export interface LibraryModelLease<View> {
  readonly snapshot: LibraryModelSnapshot<View>;
  release(): void;
}

type LibraryModelService = Pick<
  LibraryServiceSupervisor,
  | 'open'
  | 'retry'
  | 'command'
  | 'query'
  | 'task'
  | 'observe'
  | 'subscribeSnapshot'
  | 'onStatus'
  | 'close'
>;

type Command<Kind extends LibraryCommand['kind']> = Extract<LibraryCommand, { kind: Kind }>;
type Observation<Kind extends LibraryObservation['kind']> = Extract<
  LibraryObservation,
  { kind: Kind }
>;

type LeasedView =
  | HistoryView
  | DownloadsView
  | ConnectionsView
  | SimklView
  | RecoveryView
  | TitleView
  | PresenceView
  | ProfileDirectoryView;

/* eslint-disable svelte/prefer-svelte-reactivity -- The maps are subscription ownership indexes; reactive state lives in each source snapshot. */
/** Thin page-side state over the supervised authority. It owns no storage, projection, polling, or transport policy. */
export class LibraryModel {
  #overview = $state.raw<LibraryModelSnapshot<LibraryOverviewView>>(connectingSnapshot());
  #continue = $state.raw<LibraryModelSnapshot<ContinueView>>(connectingSnapshot());
  #devices = $state.raw<LibraryModelSnapshot<DevicesView>>(connectingSnapshot());
  #settings = $state.raw<LibraryModelSnapshot<SettingsView>>(connectingSnapshot());
  #runtime = $state.raw<LibraryModelSnapshot<RuntimeDiscoveryView>>(connectingSnapshot());
  #connection = $state<LibraryModelConnection>('connecting');
  #status = $state.raw<LibraryModelStatus>(Object.freeze({ kind: 'connecting' }));
  #openFailure = $state.raw<Immutable<LibraryServiceFailure> | undefined>();
  readonly #rootStops: Array<() => void> = [];
  #history?: SharedSelection<HistoryView>;
  #downloads?: SharedSelection<DownloadsView>;
  #connections?: SharedSelection<ConnectionsView>;
  #simkl?: SharedSelection<SimklView>;
  #recovery?: SharedSelection<RecoveryView>;
  #profiles?: SharedSelection<ProfileDirectoryView>;
  readonly #titles = new Map<string, SharedSelection<TitleView>>();
  readonly #presences = new Map<string, SharedSelection<PresenceView>>();
  readonly #stopStatus: () => void;
  readonly #readyWaiters = new Set<() => void>();
  #settleInitialRead = () => {};
  #closed = false;

  /** Settles only after the service and its Home-critical root replacements are ready. */
  readonly ready: Promise<LibraryVersion>;
  /**
   * Settles once the first remote read has finished filling the local fact store. `ready` may resolve after its
   * first page so Home can render while the remaining history continues in bounded pages; automatic background
   * writes use this later boundary to avoid loading mutation policy into that opening work.
   */
  readonly initialReadSettled: Promise<void>;

  constructor(
    readonly service: LibraryModelService,
    options: LibraryServiceOpenOptions,
  ) {
    let settleInitialRead!: () => void;
    let initialReadSettled = false;
    let openingProgressSeen = false;
    this.initialReadSettled = new Promise<void>((resolve) => {
      settleInitialRead = () => {
        if (initialReadSettled) return;
        initialReadSettled = true;
        resolve();
      };
    });
    this.#settleInitialRead = settleInitialRead;
    this.#rootStops.push(
      service.subscribeSnapshot({ kind: 'overview' }, (snapshot) => {
        this.#overview = modelSnapshot<LibraryOverviewView>(snapshot);
      }),
      service.subscribeSnapshot({ kind: 'continue' }, (snapshot) => {
        this.#continue = modelSnapshot<ContinueView>(snapshot);
      }),
      service.subscribeSnapshot({ kind: 'devices' }, (snapshot) => {
        this.#devices = modelSnapshot<DevicesView>(snapshot);
      }),
      service.subscribeSnapshot({ kind: 'settings' }, (snapshot) => {
        this.#settings = modelSnapshot<SettingsView>(snapshot);
      }),
      service.subscribeSnapshot({ kind: 'runtime' }, (snapshot) => {
        this.#runtime = modelSnapshot<RuntimeDiscoveryView>(snapshot);
      }),
    );
    this.#stopStatus = service.onStatus((status) => this.#receiveStatus(status));
    const progress = (value: number) => {
      openingProgressSeen = true;
      if (!this.#closed) noteLibraryOpening(this, value);
      if (value >= 1) settleInitialRead();
    };
    // Ready can come before the read is complete (the rest of the history follows the first page): the progress ends
    // at 1, or with a failed open or a closed model.
    this.ready = service
      .open({ ...options, progress })
      .then((version) => {
        // A complete saved fact store reports no progress: the ready reply is its settled boundary. A paged import
        // reports 0 before ready and 1 only after its remaining history has landed.
        if (!openingProgressSeen) settleInitialRead();
        return version;
      })
      .catch((error: unknown) => {
        noteLibraryOpening(this, null);
        settleInitialRead();
        const failure = failureFrom(error);
        if (!this.#closed) {
          this.#openFailure = failure;
          this.#connection = 'failed';
          this.#status = Object.freeze({ kind: 'failed', error: failure });
        }
        throw error;
      });
  }

  get overview(): LibraryModelSnapshot<LibraryOverviewView> {
    return this.#overview;
  }

  get continueWatching(): LibraryModelSnapshot<ContinueView> {
    return this.#continue;
  }

  /** Small playback capability; credentials and the rest of Settings' connection state stay lazy. */
  get devices(): LibraryModelSnapshot<DevicesView> {
    return this.#devices;
  }

  /** Watched history is intentionally lazy: Home must not transfer a potentially large Watchlist-only view. */
  history(): LibraryModelLease<HistoryView> {
    this.#assertOpen();
    this.#history ??= new SharedSelection<HistoryView>(
      this.service,
      { kind: 'history' },
      () => (this.#history = undefined),
    );
    return this.#history.acquire();
  }

  /** Exact watched coordinates for the bounded set of History cards currently being drawn. */
  async historyEpisodes(titles: readonly TitleRef[]): Promise<ReadonlyMap<string, SeenEpisode[]>> {
    this.#assertOpen();
    const refs = [
      ...new Map(
        titles
          .filter((title): title is TitleRef & { type: 'tv' } => title.type === 'tv')
          .slice(0, LIBRARY_SERVICE_WIRE_LIMITS.historyDetailTitles)
          .map((title) => [titleKey(title), wireTitleRef(title) as TitleRef & { type: 'tv' }]),
      ).values(),
    ];
    const { result } = await this.service.query({ kind: 'history.episodes', titles: refs });
    if (result.kind !== 'history.episodes') throw wrongQueryResult('history.episodes');
    return new Map(result.items.map((item) => [titleKey(item.title), item.seen] as const));
  }

  /** Downloads stay lazy because only the Downloads/settings surfaces render the queue. */
  downloads(): LibraryModelLease<DownloadsView> {
    this.#assertOpen();
    this.#downloads ??= new SharedSelection<DownloadsView>(
      this.service,
      { kind: 'downloads' },
      () => (this.#downloads = undefined),
    );
    return this.#downloads.acquire();
  }

  /** Connection secrets and device diagnostics load only for Settings, never as Home payload. */
  connections(): LibraryModelLease<ConnectionsView> {
    this.#assertOpen();
    this.#connections ??= new SharedSelection<ConnectionsView>(
      this.service,
      { kind: 'connections' },
      () => (this.#connections = undefined),
    );
    return this.#connections.acquire();
  }

  /** SIMKL delivery state is Settings-only and never joins the Home subscription set. */
  simkl(): LibraryModelLease<SimklView> {
    this.#assertOpen();
    this.#simkl ??= new SharedSelection<SimklView>(
      this.service,
      { kind: 'simkl' },
      () => (this.#simkl = undefined),
    );
    return this.#simkl.acquire();
  }

  recovery(): LibraryModelLease<RecoveryView> {
    this.#assertOpen();
    this.#recovery ??= new SharedSelection<RecoveryView>(
      this.service,
      { kind: 'recovery' },
      () => (this.#recovery = undefined),
    );
    return this.#recovery.acquire();
  }

  /** Household-only profile directory. It stays lazy until the profiles capability has opted this page in. */
  profiles(): LibraryModelLease<ProfileDirectoryView> {
    this.#assertOpen();
    this.#profiles ??= new SharedSelection<ProfileDirectoryView>(
      this.service,
      { kind: 'profiles' },
      () => (this.#profiles = undefined),
    );
    return this.#profiles.acquire();
  }

  get settings(): LibraryModelSnapshot<SettingsView> {
    return this.#settings;
  }

  get runtime(): LibraryModelSnapshot<RuntimeDiscoveryView> {
    return this.#runtime;
  }

  get connection(): LibraryModelConnection {
    return this.#connection;
  }

  get status(): LibraryModelStatus {
    return this.#status;
  }

  get openFailure(): Immutable<LibraryServiceFailure> | undefined {
    return this.#openFailure;
  }

  /** One shared subscription per title key, independent of display metadata for that title. */
  title(title: TitleRef): LibraryModelLease<TitleView> {
    this.#assertOpen();
    const key = titleKey(title);
    let source = this.#titles.get(key);
    if (!source) {
      source = new SharedSelection<TitleView>(
        this.service,
        { kind: 'title', title: wireTitleRef(title) },
        () => this.#titles.delete(key),
      );
      this.#titles.set(key, source);
    }
    return source.acquire();
  }

  /** Presence order is part of the wire contract, so only an identical ordered key shares a subscription. */
  presence(titles: readonly TitleRef[]): LibraryModelLease<PresenceView> {
    this.#assertOpen();
    const key = JSON.stringify(titles.map(({ type, id }) => [type, id]));
    let source = this.#presences.get(key);
    if (!source) {
      source = new SharedSelection<PresenceView>(
        this.service,
        { kind: 'presence', titles: titles.map(wireTitleRef) },
        () => this.#presences.delete(key),
      );
      this.#presences.set(key, source);
    }
    return source.acquire();
  }

  async retry(): Promise<LibraryVersion> {
    this.#assertOpen();
    this.#openFailure = undefined;
    this.#connection = 'reconnecting';
    this.#status = Object.freeze({ kind: 'reconnecting', version: null });
    try {
      return await this.service.retry();
    } catch (error) {
      const failure = failureFrom(error);
      if (!this.#closed) {
        this.#openFailure = failure;
        this.#connection = 'failed';
        this.#status = Object.freeze({ kind: 'failed', error: failure });
      }
      throw error;
    }
  }

  addToWatchlist(title: TitleRef, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'watchlist.add', title: wireTitleRef(title) }, operationId);
  }

  removeFromLibrary(title: TitleRef, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'library.remove', title: wireTitleRef(title) }, operationId);
  }

  setWatched(
    title: TitleRef,
    watched: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'watched.set', title: wireTitleRef(title), watched }, operationId);
  }

  setReaction(
    title: TitleRef,
    reaction: Reaction | null,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      { kind: 'reaction.set', title: wireTitleRef(title), reaction },
      operationId,
    );
  }

  setEpisodeWatched(
    episode: EpisodeRef,
    watched: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      { kind: 'episode-watched.set', episode: wireEpisodeRef(episode), watched },
      operationId,
    );
  }

  setSeasonWatched(
    title: TitleRef & { type: 'tv' },
    season: number,
    episodes: readonly number[],
    watched: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      {
        kind: 'season-watched.set',
        title: { type: 'tv', id: title.id },
        season,
        episodes: [...episodes],
        watched,
      },
      operationId,
    );
  }

  setContinueDismissed(
    title: TitleRef,
    dismissed: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      { kind: 'continue-dismissed.set', title: wireTitleRef(title), dismissed },
      operationId,
    );
  }

  recordProgress(
    progress: Omit<Command<'progress.record'>, 'kind'>,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      {
        kind: 'progress.record',
        ...progress,
        title: wireTitleRef(progress.title),
        ...(progress.episode ? { episode: wireEpisodeRef(progress.episode) } : {}),
      },
      operationId,
    );
  }

  patchPreferences(
    patch: LibraryPreferencesPatch,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'preferences.patch', patch }, operationId);
  }

  /** The stored `set:prefs` values with their stamps: what profile seeding reads from an older household. */
  async rawPreferences(): Promise<StoredPreferenceValues> {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'preferences.raw' });
    if (result.kind !== 'preferences.raw') throw wrongQueryResult('raw preferences');
    return result.values;
  }

  /** The relay-only proof of this exact model's library, independent of whichever profile is globally active. */
  async relayMembership(): Promise<LibraryRelayMembership | null> {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'relay.membership' });
    if (result.kind !== 'relay.membership') throw wrongQueryResult('relay membership');
    return result.capability;
  }

  /** Give this profile library the preferences `household` holds that it has not decided (profiles-v1 §6.3). */
  seedPreferences(
    household: StoredPreferenceValues,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'preferences.seed', household }, operationId);
  }

  setApiKey(
    service: LibraryApiKeyService,
    value: string | null,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'api-key.set', service, value }, operationId);
  }

  setParentalPin(pin: string | null, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'parental-pin.set', pin }, operationId);
  }

  async verifyParentalPin(pin: string): Promise<boolean> {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'parental-pin.verify', pin });
    if (result.kind !== 'parental-pin.verify')
      throw new LibraryServiceError({
        code: 'internal',
        message: 'library service returned the wrong parental PIN result',
        retryable: true,
      });
    return result.matches;
  }

  async profileCreateStatus() {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'profile-create.status' });
    if (result.kind !== 'profile-create.status') throw wrongQueryResult('profile create status');
    if (result.phase === 'created') await this.#ackProfileCreate(result.receipt!);
    return result;
  }

  async createKidProfile(name: string, maximumAge: number, pin: string, operationId?: string) {
    const created = await this.task({ kind: 'profile.create', name, maximumAge, pin }, operationId);
    if (created.result.kind !== 'profile.create') throw wrongQueryResult('profile create');
    await this.#ackProfileCreate(created.result.receipt);
    return created;
  }

  /** Change a Kid's content policy behind the Owner PIN; resolves once the directory holds it. */
  async setKidPolicy(
    profile: string,
    policy: { maximumAge: number | null; unknownRatings: 'allow' | 'block' },
    pin: string,
  ): Promise<'changed' | 'unchanged'> {
    const { result } = await this.task({ kind: 'profile.policy.set', profile, ...policy, pin });
    if (result.kind !== 'profile.policy.set') throw wrongQueryResult('profile policy');
    return result.outcome;
  }

  async setKidTitleApproval(
    profile: string,
    title: TitleRef,
    allow: boolean,
    pin: string,
  ): Promise<'changed' | 'unchanged'> {
    const { result } = await this.task({
      kind: 'kid-title-approval.set',
      profile,
      title,
      allow,
      pin,
    });
    if (result.kind !== 'kid-title-approval.set') throw wrongQueryResult('Kid title approval');
    return result.outcome;
  }

  /**
   * The household's Kid when its directory has none yet; `present` when one already exists. Asked fresh each time
   * (the Kid journal makes it once): the answer also brings in a directory this page had not read yet.
   */
  async ensureDefaultKidProfile(): Promise<'created' | 'present'> {
    const { result } = await this.task({ kind: 'profile.create-default' });
    if (result.kind !== 'profile.create-default') throw wrongQueryResult('default Kid profile');
    return result.outcome;
  }

  async #ackProfileCreate(receipt: string): Promise<void> {
    const acknowledged = await this.task({ kind: 'profile.create.ack', receipt });
    if (acknowledged.result.kind !== 'profile.create.ack')
      throw wrongQueryResult('profile create acknowledgement');
  }

  setRemoteAccess(
    credentials: { clientId: string; clientSecret: string } | null,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'remote-access.set', credentials }, operationId);
  }

  installPlugin(manifestUrl: string, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'plugin.install', manifestUrl }, operationId);
  }

  removePlugin(manifestUrl: string, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'plugin.remove', manifestUrl }, operationId);
  }

  setPluginTrust(
    manifestUrl: string,
    publicKey: string | null,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'plugin-trust.set', manifestUrl, publicKey }, operationId);
  }

  patchServer(
    server: MediaServerKind,
    value: { url: string; user?: string; credential?: string } | null,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'server.patch', server, value }, operationId);
  }

  heartbeatDevice(
    name: string,
    operationId?: string,
    deviceKind: 'tv' | 'browser' = 'browser',
    playKey?: string,
    controlVersion?: number,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      {
        kind: 'device.heartbeat',
        name,
        deviceKind,
        ...(playKey ? { playKey } : {}),
        ...(controlVersion ? { controlVersion } : {}),
      },
      operationId,
    );
  }

  /** Record that a play sent from another device started on this TV. */
  markPlayed(operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'device.played' }, operationId);
  }

  removeDevice(deviceId: string, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'device.remove', deviceId }, operationId);
  }

  connectSimkl(token: string, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'simkl.connect', token }, operationId);
  }

  disconnectSimkl(operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'simkl.disconnect' }, operationId);
  }

  approveSimklRemovals(
    approvalId: string,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'simkl.removals.approve', approvalId }, operationId);
  }

  rememberPrivateRemux(url: string, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'discovery.remux.remember', url }, operationId);
  }

  retainServices(
    value: RetainedServices,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'retained.services.set', value }, operationId);
  }

  retainHomeContinue(present: boolean, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'retained.home-continue.set', present }, operationId);
  }

  retainBillboard(
    scope: RetainedBillboardScope,
    value: RetainedBillboard,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    // Billboard titles can come back through reactive Home state before a refreshed personal ranking reuses
    // them. A Svelte proxy satisfies the structural protocol decoder but cannot cross postMessage; make this
    // service boundary a real wire boundary so one cosmetic keep can never take down the shared Worker.
    return this.#command(
      {
        kind: 'retained.billboard.set',
        scope: structuredClone($state.snapshot(scope)) as RetainedBillboardScope,
        value: structuredClone($state.snapshot(value)) as RetainedBillboard,
      },
      operationId,
    );
  }

  async retainedServices(): Promise<Immutable<RetainedServices> | null> {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'retained.services.get' });
    if (result.kind !== 'retained.services') throw wrongQueryResult('retained services');
    return result.value as Immutable<RetainedServices> | null;
  }

  async retainedHomeContinue(): Promise<boolean | null> {
    this.#assertOpen();
    const { result } = await this.#retainedQuery({ kind: 'retained.home-continue.get' });
    if (result.kind !== 'retained.home-continue') throw wrongQueryResult('retained Home hint');
    return result.present;
  }

  async retainedBillboard(
    scope: RetainedBillboardScope,
  ): Promise<Immutable<RetainedBillboard> | null> {
    this.#assertOpen();
    const { result } = await this.#retainedQuery({
      kind: 'retained.billboard.get',
      scope: structuredClone(scope),
    });
    if (result.kind !== 'retained.billboard') throw wrongQueryResult('retained billboard');
    return result.value as Immutable<RetainedBillboard> | null;
  }

  enqueueDownload(
    title: DownloadTitleDescriptor,
    release: DownloadReleaseDescriptor,
    candidates?: number,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      {
        kind: 'download.enqueue',
        title: wireDownloadTitle(title),
        release: {
          identity: release.identity,
          label: release.label,
          ...(release.sizeBytes !== undefined ? { sizeBytes: release.sizeBytes } : {}),
          ...(release.cached !== undefined ? { cached: release.cached } : {}),
        },
        ...(candidates === undefined ? {} : { candidates }),
      },
      operationId,
    );
  }

  /** Keep asking for content with nothing to fetch yet; the download is searched for again until one turns up. */
  wantDownload(
    title: DownloadTitleDescriptor,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'download.want', title: wireDownloadTitle(title) }, operationId);
  }

  removeDownload(
    target: DownloadTarget,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      { kind: 'download.remove', target: wireDownloadTarget(target) },
      operationId,
    );
  }

  tryDownloadRelease(
    target: DownloadTarget,
    identity: string,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      { kind: 'download.release.try', target: wireDownloadTarget(target), identity },
      operationId,
    );
  }

  refreshDownloads(target?: DownloadTarget) {
    this.#assertOpen();
    return this.service.query({
      kind: 'download.refresh',
      ...(target ? { target: wireDownloadTarget(target) } : {}),
    });
  }

  async libraryMetadata(titles: readonly TitleRef[]): Promise<{
    titles: LibraryMetadataTitle[];
    shapes: LibraryMetadataShape[];
    retryable: TitleRef[];
    retryAfterMs?: number;
  }> {
    this.#assertOpen();
    const refs = [
      ...new Map(
        titles.map((title) => {
          const ref = wireTitleRef(title);
          return [titleKey(ref), ref] as const;
        }),
      ).values(),
    ];
    const { result } = await this.service.query({ kind: 'library.metadata', titles: refs });
    if (result.kind !== 'library.metadata') throw wrongQueryResult('library.metadata');
    return {
      titles: result.titles,
      shapes: result.shapes,
      retryable: result.retryable,
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    };
  }

  downloadSources(title: DownloadTitleDescriptor, refresh = false) {
    this.#assertOpen();
    return this.service.query({
      kind: 'download.sources',
      title: wireDownloadTitle(title),
      ...(refresh ? { refresh } : {}),
    });
  }

  downloadArtwork(target: DownloadTarget) {
    this.#assertOpen();
    return this.service.query({ kind: 'download.artwork', target: wireDownloadTarget(target) });
  }

  task(
    task: LibraryTask,
    operationId?: string,
  ): Promise<{ result: LibraryTaskResult; version: LibraryVersion }> {
    this.#assertOpen();
    return this.service.task(task, operationId);
  }

  importHistory(items: readonly HistoryImportItem[], operationId?: string) {
    return this.task(
      {
        kind: 'history.import',
        items: structuredClone($state.snapshot(items)) as HistoryImportItem[],
      },
      operationId,
    );
  }

  exportHistory() {
    this.#assertOpen();
    return this.service.query({ kind: 'history.export' });
  }

  prepareKeyReset() {
    this.#assertOpen();
    return this.service.query({ kind: 'key-reset.prepare' });
  }

  sealRecovery(locator: string, wrapKey: string, createdAt: number) {
    this.#assertOpen();
    return this.service.query({ kind: 'recovery.seal', locator, wrapKey, createdAt });
  }

  beginRecovery(locator: string, sealed: string, createdAt: number, operationId?: string) {
    return this.task({ kind: 'recovery.begin', locator, sealed, createdAt }, operationId);
  }

  confirmRecovery(locator: string, operationId?: string) {
    return this.task({ kind: 'recovery.confirm', locator }, operationId);
  }

  abandonRecovery(locator: string, operationId?: string) {
    return this.task({ kind: 'recovery.abandon', locator }, operationId);
  }

  disableRecovery(operationId?: string) {
    return this.task({ kind: 'recovery.disable' }, operationId);
  }

  moveLibraryKey(destinationLibraryKey: string, operationId?: string) {
    return this.task({ kind: 'key-reset.move', destinationLibraryKey }, operationId);
  }

  settleLibraryKey(destinationLibraryKey: string, operationId?: string) {
    return this.task({ kind: 'key-reset.settle', destinationLibraryKey }, operationId);
  }

  adoptLibraryKey(destinationLibraryKey: string, operationId?: string) {
    return this.task({ kind: 'key-reset.adopt', destinationLibraryKey }, operationId);
  }

  startProfileKeyReset(pin: string, destinationLibraryKey: string, operationId?: string) {
    return this.task({ kind: 'profile-key-reset.start', pin, destinationLibraryKey }, operationId);
  }

  resumeProfileKeyReset(operationId?: string) {
    return this.task({ kind: 'profile-key-reset.resume' }, operationId);
  }

  confirmProfileKeyReset(destinationLibraryKey: string, operationId?: string) {
    return this.task({ kind: 'profile-key-reset.confirm', destinationLibraryKey }, operationId);
  }

  recoverProfileKeyReset(
    pin: string,
    recoveryAttempt: string,
    successorKey: string | null,
    operationId?: string,
  ) {
    return this.task(
      { kind: 'profile-key-reset.recover', pin, recoveryAttempt, successorKey },
      operationId,
    );
  }

  mergeLocalLibrary(
    sourceLibraryKey: string,
    operationId?: string,
    part: { scope?: 'household' | 'profile'; keep?: true; verify?: true } = {},
  ) {
    return this.task({ kind: 'local-library.merge', sourceLibraryKey, ...part }, operationId);
  }

  /** This browser's own household joins the one this model opens (`household.join`); asked again, it finishes it. */
  async joinHousehold(
    sourceLibraryKey: string,
    pin?: string,
  ): Promise<Extract<LibraryTaskResult, { kind: 'household.join' }>> {
    const { result } = await this.task({
      kind: 'household.join',
      sourceLibraryKey,
      ...(pin === undefined ? {} : { pin }),
    });
    if (result.kind !== 'household.join') throw wrongQueryResult('household join');
    return result;
  }

  /** Start or finish this browser's own household (`household.create`); asked of the library kept only here. */
  async createHousehold(
    plan: Omit<Extract<LibraryTask, { kind: 'household.create' }>, 'kind'>,
  ): Promise<Extract<LibraryTaskResult, { kind: 'household.create' }>> {
    const { result } = await this.task({ kind: 'household.create', ...plan });
    if (result.kind !== 'household.create') throw wrongQueryResult('household create');
    return result;
  }

  /**
   * Write a grant (to write) and a read record (to read) for an assistant into the library; their keys, for
   * den-edge's approval and nothing else.
   */
  async consentAssistant(
    client: string,
    allow: { write: boolean; read: boolean },
  ): Promise<{ grant: string; key: string; readKey?: string }> {
    const { result } = await this.task({ kind: 'assistant.consent', client, ...allow });
    if (result.kind !== 'assistant.consent') throw wrongQueryResult('assistant consent');
    return {
      grant: result.grant,
      key: result.key,
      ...(result.readKey ? { readKey: result.readKey } : {}),
    };
  }

  /**
   * Publish every live read grant's projection that is due (§15). How many were sent. `connection`: a split
   * household's (`assistantConnection`), which this, Owner's library, publishes its lists for.
   */
  async publishAssistant(connection?: AssistantConnection): Promise<number> {
    const { result } = await this.task({
      kind: 'assistant.publish',
      ...(connection ? { connection } : {}),
    });
    if (result.kind !== 'assistant.publish') throw wrongQueryResult('assistant publish');
    return result.published;
  }

  /** Mark an assistant's grant revoked in the library, which every device enforces. */
  async revokeAssistant(grant: string): Promise<'revoked' | 'absent'> {
    const { result } = await this.task({ kind: 'assistant.revoke', grant });
    if (result.kind !== 'assistant.revoke') throw wrongQueryResult('assistant revoke');
    return result.outcome;
  }

  /** The grants, read and play records the library holds, whatever their state, for Settings › Assistants. */
  async assistantGrants() {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'assistant.grants' });
    if (result.kind !== 'assistant.grants') throw wrongQueryResult('assistant grants');
    return { grants: result.grants, reads: result.reads, plays: result.plays };
  }

  /**
   * This household's assistant connection, to lend Owner's library on a household split into profiles; null while
   * den-edge does not know this library as a member.
   */
  async assistantConnection(): Promise<AssistantConnection | null> {
    this.#assertOpen();
    const { result } = await this.service.query({ kind: 'assistant.connection' });
    if (result.kind !== 'assistant.connection') throw wrongQueryResult('assistant connection');
    return result.connection;
  }

  /** Keep the grants whose connection den-edge still lists from expiring (at most daily). */
  async renewAssistant(grants: readonly string[]): Promise<number> {
    const { result } = await this.task({ kind: 'assistant.renew', grants: [...grants] });
    if (result.kind !== 'assistant.renew') throw wrongQueryResult('assistant renew');
    return result.renewed;
  }

  /**
   * Open, check and apply a drain of the assistant queue (`assistant.ts`). `connection`: a split household's, whose
   * queue it is; this, Owner's library, applies it.
   */
  async applyAssistant(
    messages: ReadonlyArray<{ seq: number; sealed: string }>,
    connection?: AssistantConnection,
    tv?: { awakeSince: number },
  ) {
    const { result } = await this.task({
      kind: 'assistant.apply',
      messages: messages.map(({ seq, sealed }) => ({ seq, sealed })),
      ...(connection ? { connection } : {}),
      ...(tv ? { tv } : {}),
    });
    if (result.kind !== 'assistant.apply') throw wrongQueryResult('assistant apply');
    return result;
  }

  sealPairingHandover(handoverKey: string, host: string, linkKey?: string, grantTicket?: string) {
    this.#assertOpen();
    return this.service.query({
      kind: 'pairing.handover',
      handoverKey,
      host,
      ...(linkKey ? { linkKey } : {}),
      ...(grantTicket ? { grantTicket } : {}),
    });
  }

  preparePlayback(
    title: TitleRef,
    episode?: EpisodeRef,
  ): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    this.#assertOpen();
    return this.service.query({
      kind: 'playback.prepare',
      title: wireTitleRef(title),
      ...(episode ? { episode: wireEpisodeRef(episode) } : {}),
    });
  }

  observeTitleShape(shape: Omit<Observation<'title-shape'>, 'kind'>): Promise<LibraryVersion> {
    this.#assertOpen();
    return this.service.observe({
      kind: 'title-shape',
      ...shape,
      title: { type: 'tv', id: shape.title.id },
    });
  }

  observeLifecycle(lifecycle: Omit<Observation<'lifecycle'>, 'kind'>): Promise<LibraryVersion> {
    this.#assertOpen();
    return this.service.observe({ kind: 'lifecycle', ...lifecycle });
  }

  foregroundReady(): Promise<LibraryVersion> {
    this.#assertOpen();
    return this.service.observe({ kind: 'foreground-ready' });
  }

  /** @deprecated Use foregroundReady. */
  observeForegroundReady(): Promise<LibraryVersion> {
    return this.foregroundReady();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    noteLibraryOpening(this, null);
    this.#settleInitialRead();
    for (const stop of this.#rootStops.splice(0)) stop();
    this.#stopStatus();
    for (const source of this.#titles.values()) source.close();
    for (const source of this.#presences.values()) source.close();
    this.#titles.clear();
    this.#presences.clear();
    this.#overview = closedSnapshot(this.#overview);
    this.#continue = closedSnapshot(this.#continue);
    this.#devices = closedSnapshot(this.#devices);
    this.#history?.close();
    this.#history = undefined;
    this.#downloads?.close();
    this.#downloads = undefined;
    this.#connections?.close();
    this.#connections = undefined;
    this.#simkl?.close();
    this.#simkl = undefined;
    this.#recovery?.close();
    this.#recovery = undefined;
    this.#profiles?.close();
    this.#profiles = undefined;
    this.#settings = closedSnapshot(this.#settings);
    this.#runtime = closedSnapshot(this.#runtime);
    this.#connection = 'closed';
    this.#status = Object.freeze({ kind: 'closed' });
    for (const waiter of [...this.#readyWaiters]) waiter();
    this.service.close();
  }

  /**
   * What a page kept for its first paint, asked again once the service is back when it was asked while the service
   * reconnects (the household reopens on a newer wire at startup). A refused read answered as "nothing kept" paints
   * the fallback over what was kept.
   */
  async #retainedQuery(
    query: Extract<LibraryQuery, { kind: 'retained.billboard.get' | 'retained.home-continue.get' }>,
  ): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.service.query(query);
      } catch (error) {
        const { code, retryable } = failureFrom(error);
        if (code !== 'not-ready' || !retryable || attempt === RETAINED_READ_ATTEMPTS) throw error;
        await this.#reconnected();
      }
    }
  }

  /** Settles once the service reports ready again, or after a bounded wait: the caller asks again either way. */
  #reconnected(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#readyWaiters.delete(done);
        resolve();
      };
      // A service that already reports ready is still refusing for a moment: look again shortly.
      const timer = setTimeout(
        done,
        this.#connection === 'ready' ? RETAINED_READ_RETRY_MS : RECONNECT_WAIT_MS,
      );
      this.#readyWaiters.add(done);
    });
  }

  #command(command: LibraryCommand, operationId?: string): Promise<LibraryServiceCommandResult> {
    this.#assertOpen();
    return operationId === undefined
      ? this.service.command(command)
      : this.service.command(command, operationId);
  }

  #receiveStatus(status: LibrarySessionStatus): void {
    if (this.#closed) return;
    this.#status = Object.freeze(status) as Immutable<LibrarySessionStatus>;
    if (status.kind === 'ready') {
      this.#connection = 'ready';
      this.#openFailure = undefined;
      for (const waiter of [...this.#readyWaiters]) waiter();
    } else if (status.kind === 'reconnecting') this.#connection = 'reconnecting';
    else if (status.kind === 'moved') {
      this.#connection = 'failed';
    } else if (status.kind === 'failed') {
      this.#connection = 'failed';
      this.#openFailure = Object.freeze(status.error);
    }
  }

  #assertOpen(): void {
    if (!this.#closed) return;
    throw new LibraryServiceError({
      code: 'cancelled',
      message: 'library model is closed',
      retryable: false,
    });
  }
}

class SharedSelection<View extends LeasedView> {
  #snapshot = $state.raw<LibraryModelSnapshot<View>>(connectingSnapshot());
  readonly #stop: () => void;
  #references = 0;
  #closed = false;

  constructor(
    service: LibraryModelService,
    selection:
      | { kind: 'history' }
      | { kind: 'downloads' }
      | { kind: 'connections' }
      | { kind: 'simkl' }
      | { kind: 'recovery' }
      | { kind: 'profiles' }
      | { kind: 'title'; title: TitleRef }
      | { kind: 'presence'; titles: TitleRef[] },
    readonly unused: () => void,
  ) {
    this.#stop = service.subscribeSnapshot(selection, (snapshot) => {
      if (!this.#closed) this.#snapshot = modelSnapshot<View>(snapshot);
    });
  }

  get snapshot(): LibraryModelSnapshot<View> {
    return this.#snapshot;
  }

  acquire(): LibraryModelLease<View> {
    this.#references++;
    return new SelectionLease(this, () => this.#release());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop();
    this.#snapshot = closedSnapshot(this.#snapshot);
  }

  #release(): void {
    if (this.#references === 0) return;
    this.#references--;
    if (this.#references > 0 || this.#closed) return;
    this.close();
    this.unused();
  }
}

class SelectionLease<View extends LeasedView> implements LibraryModelLease<View> {
  #released?: LibraryModelSnapshot<View>;

  constructor(
    readonly source: SharedSelection<View>,
    readonly releaseSource: () => void,
  ) {}

  get snapshot(): LibraryModelSnapshot<View> {
    return this.#released ?? this.source.snapshot;
  }

  release(): void {
    if (this.#released) return;
    this.#released = this.source.snapshot;
    this.releaseSource();
  }
}

function connectingSnapshot<View>(): LibraryModelSnapshot<View> {
  return Object.freeze({ connection: 'connecting' });
}

function modelSnapshot<View>(snapshot: LibrarySelectionSnapshot): LibraryModelSnapshot<View> {
  return Object.freeze({
    connection: snapshot.connection,
    ...(snapshot.value ? { value: snapshot.value as Immutable<View> } : {}),
    ...(snapshot.version ? { version: snapshot.version } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  });
}

function closedSnapshot<View>(snapshot: LibraryModelSnapshot<View>): LibraryModelSnapshot<View> {
  return Object.freeze({
    connection: 'closed',
    ...(snapshot.value ? { value: snapshot.value } : {}),
    ...(snapshot.version ? { version: snapshot.version } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  });
}

function failureFrom(error: unknown): Immutable<LibraryServiceFailure> {
  const failure =
    error instanceof LibraryServiceError
      ? error.failure
      : {
          code: 'unavailable' as const,
          message: error instanceof Error ? error.message : 'library service is unavailable',
          retryable: true,
        };
  return Object.freeze(failure);
}

function wrongQueryResult(wanted: string): LibraryServiceError {
  return new LibraryServiceError({
    code: 'internal',
    message: `library service returned the wrong ${wanted} result`,
    retryable: true,
  });
}

function titleKey(title: TitleRef): string {
  return `${title.type}:${title.id}`;
}

/** TypeScript permits richer display objects here; the strict service wire deliberately does not. */
function wireTitleRef(title: TitleRef): TitleRef {
  return { type: title.type, id: title.id };
}

function wireEpisodeRef(episode: EpisodeRef): EpisodeRef {
  return {
    type: 'tv',
    id: episode.id,
    season: episode.season,
    episode: episode.episode,
  };
}

function wireDownloadTarget(target: DownloadTarget): DownloadTarget {
  return target.type === 'movie' ? { type: 'movie', id: target.id } : wireEpisodeRef(target);
}

function wireDownloadTitle(title: DownloadTitleDescriptor): DownloadTitleDescriptor {
  return {
    target: wireDownloadTarget(title.target),
    name: title.name,
    ...(title.imdbId !== undefined ? { imdbId: title.imdbId } : {}),
    ...(title.posterPath !== undefined ? { posterPath: title.posterPath } : {}),
    ...(title.stillPath !== undefined ? { stillPath: title.stillPath } : {}),
    ...(title.originalLanguage !== undefined ? { originalLanguage: title.originalLanguage } : {}),
    ...(title.airDate !== undefined ? { airDate: title.airDate } : {}),
  };
}
