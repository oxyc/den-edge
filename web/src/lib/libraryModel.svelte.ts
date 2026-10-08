import { LibraryServiceError, type LibraryServiceOpenOptions } from './libraryServiceClient';
import type {
  ContinueView,
  DownloadReleaseDescriptor,
  DownloadTarget,
  DownloadTitleDescriptor,
  DownloadsView,
  EpisodeRef,
  HistoryView,
  LibraryCommand,
  LibraryObservation,
  LibraryOverviewView,
  LibraryPreferencesPatch,
  LibraryQueryResult,
  LibraryServiceCommandResult,
  LibraryServiceFailure,
  LibrarySessionStatus,
  LibraryVersion,
  PresenceView,
  Reaction,
  SettingsView,
  TitleRef,
  TitleView,
} from './libraryServiceProtocol';
import type {
  LibrarySelectionConnection,
  LibrarySelectionSnapshot,
  LibraryServiceSupervisor,
} from './libraryServiceSupervisor';

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

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
  'open' | 'retry' | 'command' | 'query' | 'observe' | 'subscribeSnapshot' | 'onStatus' | 'close'
>;

type Command<Kind extends LibraryCommand['kind']> = Extract<LibraryCommand, { kind: Kind }>;
type Observation<Kind extends LibraryObservation['kind']> = Extract<
  LibraryObservation,
  { kind: Kind }
>;

type LeasedView = HistoryView | DownloadsView | TitleView | PresenceView;

/* eslint-disable svelte/prefer-svelte-reactivity -- The maps are subscription ownership indexes; reactive state lives in each source snapshot. */
/** Thin page-side state over the supervised authority. It owns no storage, projection, polling, or transport policy. */
export class LibraryModel {
  #overview = $state.raw<LibraryModelSnapshot<LibraryOverviewView>>(connectingSnapshot());
  #continue = $state.raw<LibraryModelSnapshot<ContinueView>>(connectingSnapshot());
  #settings = $state.raw<LibraryModelSnapshot<SettingsView>>(connectingSnapshot());
  #connection = $state<LibraryModelConnection>('connecting');
  #status = $state.raw<LibraryModelStatus>(Object.freeze({ kind: 'connecting' }));
  #openFailure = $state.raw<Immutable<LibraryServiceFailure> | undefined>();
  readonly #rootStops: Array<() => void> = [];
  #history?: SharedSelection<HistoryView>;
  #downloads?: SharedSelection<DownloadsView>;
  readonly #titles = new Map<string, SharedSelection<TitleView>>();
  readonly #presences = new Map<string, SharedSelection<PresenceView>>();
  readonly #stopStatus: () => void;
  #closed = false;

  /** Settles only after the service and all three Home-critical root replacements are ready. */
  readonly ready: Promise<LibraryVersion>;

  constructor(
    readonly service: LibraryModelService,
    options: LibraryServiceOpenOptions,
  ) {
    this.#rootStops.push(
      service.subscribeSnapshot({ kind: 'overview' }, (snapshot) => {
        this.#overview = modelSnapshot<LibraryOverviewView>(snapshot);
      }),
      service.subscribeSnapshot({ kind: 'continue' }, (snapshot) => {
        this.#continue = modelSnapshot<ContinueView>(snapshot);
      }),
      service.subscribeSnapshot({ kind: 'settings' }, (snapshot) => {
        this.#settings = modelSnapshot<SettingsView>(snapshot);
      }),
    );
    this.#stopStatus = service.onStatus((status) => this.#receiveStatus(status));
    this.ready = service.open(options).catch((error: unknown) => {
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

  get settings(): LibraryModelSnapshot<SettingsView> {
    return this.#settings;
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
        { kind: 'title', title: structuredClone(title) },
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
        { kind: 'presence', titles: structuredClone(titles) as TitleRef[] },
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
    return this.#command({ kind: 'watchlist.add', title }, operationId);
  }

  removeFromLibrary(title: TitleRef, operationId?: string): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'library.remove', title }, operationId);
  }

  setWatched(
    title: TitleRef,
    watched: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'watched.set', title, watched }, operationId);
  }

  setReaction(
    title: TitleRef,
    reaction: Reaction | null,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'reaction.set', title, reaction }, operationId);
  }

  setEpisodeWatched(
    episode: EpisodeRef,
    watched: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'episode-watched.set', episode, watched }, operationId);
  }

  setSeasonWatched(
    title: TitleRef & { type: 'tv' },
    season: number,
    episodes: readonly number[],
    watched: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command(
      { kind: 'season-watched.set', title, season, episodes: [...episodes], watched },
      operationId,
    );
  }

  setContinueDismissed(
    title: TitleRef,
    dismissed: boolean,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'continue-dismissed.set', title, dismissed }, operationId);
  }

  recordProgress(
    progress: Omit<Command<'progress.record'>, 'kind'>,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'progress.record', ...progress }, operationId);
  }

  patchPreferences(
    patch: LibraryPreferencesPatch,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'preferences.patch', patch }, operationId);
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
        title,
        release,
        ...(candidates === undefined ? {} : { candidates }),
      },
      operationId,
    );
  }

  removeDownload(
    target: DownloadTarget,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'download.remove', target }, operationId);
  }

  tryDownloadRelease(
    target: DownloadTarget,
    release: DownloadReleaseDescriptor,
    operationId?: string,
  ): Promise<LibraryServiceCommandResult> {
    return this.#command({ kind: 'download.release.try', target, release }, operationId);
  }

  preparePlayback(
    title: TitleRef,
    episode?: EpisodeRef,
  ): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    this.#assertOpen();
    return this.service.query({ kind: 'playback.prepare', title, ...(episode ? { episode } : {}) });
  }

  observeTitleShape(shape: Omit<Observation<'title-shape'>, 'kind'>): Promise<LibraryVersion> {
    this.#assertOpen();
    return this.service.observe({ kind: 'title-shape', ...shape });
  }

  observeLifecycle(lifecycle: Omit<Observation<'lifecycle'>, 'kind'>): Promise<LibraryVersion> {
    this.#assertOpen();
    return this.service.observe({ kind: 'lifecycle', ...lifecycle });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#rootStops.splice(0)) stop();
    this.#stopStatus();
    for (const source of this.#titles.values()) source.close();
    for (const source of this.#presences.values()) source.close();
    this.#titles.clear();
    this.#presences.clear();
    this.#overview = closedSnapshot(this.#overview);
    this.#continue = closedSnapshot(this.#continue);
    this.#history?.close();
    this.#history = undefined;
    this.#downloads?.close();
    this.#downloads = undefined;
    this.#settings = closedSnapshot(this.#settings);
    this.#connection = 'closed';
    this.#status = Object.freeze({ kind: 'closed' });
    this.service.close();
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
    } else if (status.kind === 'reconnecting') this.#connection = 'reconnecting';
    else if (status.kind === 'failed') this.#connection = 'failed';
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

function titleKey(title: TitleRef): string {
  return `${title.type}:${title.id}`;
}
