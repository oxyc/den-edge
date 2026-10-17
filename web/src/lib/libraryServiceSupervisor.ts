import {
  LibraryServiceClient,
  LibraryServiceError,
  type LibraryServiceOpenOptions,
  type LibraryServiceTransport,
} from './libraryServiceClient';
import type {
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibraryQueryResult,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceCommandResult,
  LibraryServiceFailure,
  LibraryTask,
  LibraryTaskResult,
  LibrarySessionStatus,
  LibraryVersion,
} from './libraryServiceProtocol';
import { startupFailure, startupMark } from './startupTiming';

export interface LibraryServiceClientPort {
  open(options: LibraryServiceOpenOptions): Promise<LibraryVersion>;
  command(command: LibraryCommand, operationId?: string): Promise<LibraryServiceCommandResult>;
  query(query: LibraryQuery): Promise<{ result: LibraryQueryResult; version: LibraryVersion }>;
  task(
    task: LibraryTask,
    operationId?: string,
  ): Promise<{ result: LibraryTaskResult; version: LibraryVersion }>;
  observe(observation: LibraryObservation): Promise<LibraryVersion>;
  subscribe(
    selection: LibrarySelection,
    listener: (value: LibrarySelectionValue, version: LibraryVersion) => void,
  ): Promise<() => void>;
  onStatus(listener: (status: LibrarySessionStatus) => void): () => void;
  close(): void;
}

export type LibraryServiceClientFactory = () => LibraryServiceClientPort;

export type LibrarySelectionConnection = 'connecting' | 'ready' | 'reconnecting' | 'failed';

/** One immutable assignment for a selector, retaining its last replacement while the worker restarts. */
export interface LibrarySelectionSnapshot {
  selection: LibrarySelection;
  connection: LibrarySelectionConnection;
  value?: LibrarySelectionValue;
  version?: LibraryVersion;
  error?: LibraryServiceFailure;
}

interface Subscription {
  selection: LibrarySelection;
  listener: (snapshot: LibrarySelectionSnapshot) => void;
  snapshot: LibrarySelectionSnapshot;
  /** Registered before open: the model's roots must all replace before the connection is ready. */
  required: boolean;
  staged?: { token: number; snapshot: LibrarySelectionSnapshot };
  stopClient?: () => void;
  seenToken?: number;
  attemptedToken?: number;
}

type Phase = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';

interface ActiveClient {
  client: LibraryServiceClientPort;
  token: number;
  stopStatus: () => void;
  version?: LibraryVersion;
  failure?: LibraryServiceFailure;
}

export interface LibraryServiceSupervisorOptions {
  /** Consecutive replacement workers allowed before an explicit retry. */
  maxAutomaticRestarts?: number;
  /** Host-scoped, fail-closed authorization for the one legacy-wire-4 to household-wire-5 bootstrap. */
  profileHouseholdEnabled?: () => Promise<boolean>;
  /** A household this browser saw bootstrapped before: it opens on wire 5 once the host enables profiles. */
  knownProfileHousehold?: (libraryKey: string) => Promise<boolean>;
  /** Called once a household refused on wire 4 has opened on wire 5. */
  onProfileHouseholdBootstrapped?: (libraryKey: string) => void;
}

/**
 * Owns one transport kind for a library session. It restores selector subscriptions after a worker crash, but never
 * replays commands or silently promotes an inline implementation to authority.
 */
export class LibraryServiceSupervisor implements LibraryServiceClientPort {
  readonly #subscriptions = new Map<number, Subscription>();
  readonly #observations = new Map<string, LibraryObservation>();
  readonly #statusListeners = new Set<(status: LibrarySessionStatus) => void>();
  readonly #maxAutomaticRestarts: number;
  readonly #profileHouseholdEnabled: () => Promise<boolean>;
  readonly #knownProfileHousehold: (libraryKey: string) => Promise<boolean>;
  readonly #onProfileHouseholdBootstrapped: (libraryKey: string) => void;
  #automaticRestartsLeft: number;
  #bootstrapped = false;
  #nextSubscription = 0;
  #nextToken = 0;
  #openOptions?: LibraryServiceOpenOptions;
  #phase: Phase = 'idle';
  #active?: ActiveClient;
  #connecting?: Promise<LibraryVersion>;
  #version?: LibraryVersion;
  #failure?: LibraryServiceFailure;
  #lastStatus?: LibrarySessionStatus;

  constructor(
    private readonly createClient: LibraryServiceClientFactory,
    options: LibraryServiceSupervisorOptions = {},
  ) {
    const maxAutomaticRestarts = options.maxAutomaticRestarts ?? 1;
    if (!Number.isInteger(maxAutomaticRestarts) || maxAutomaticRestarts < 0)
      throw new RangeError('maxAutomaticRestarts must be a non-negative integer');
    this.#maxAutomaticRestarts = maxAutomaticRestarts;
    this.#automaticRestartsLeft = maxAutomaticRestarts;
    this.#profileHouseholdEnabled = options.profileHouseholdEnabled ?? (async () => false);
    this.#knownProfileHousehold = options.knownProfileHousehold ?? (async () => false);
    this.#onProfileHouseholdBootstrapped = options.onProfileHouseholdBootstrapped ?? (() => {});
  }

  static forTransport(
    createTransport: () => LibraryServiceTransport,
    options?: LibraryServiceSupervisorOptions,
  ): LibraryServiceSupervisor {
    return new LibraryServiceSupervisor(() => new LibraryServiceClient(createTransport()), options);
  }

  open(options: LibraryServiceOpenOptions): Promise<LibraryVersion> {
    this.#assertNotClosed();
    if (this.#openOptions && !sameOpenOptions(this.#openOptions, options))
      return Promise.reject(
        new LibraryServiceError({
          code: 'conflict',
          message: 'library service supervisor is already bound to different open options',
          retryable: false,
        }),
      );
    this.#openOptions = structuredClone({ ...options, wire: options.wire ?? 4 });
    if (this.#phase === 'ready') return Promise.resolve(this.#version!);
    if (this.#connecting) return this.#connecting;
    if (this.#phase === 'failed') return Promise.reject(new LibraryServiceError(this.#failure!));
    return this.#beginConnection(this.#phase !== 'idle');
  }

  async retry(): Promise<LibraryVersion> {
    this.#assertNotClosed();
    if (!this.#openOptions)
      throw new LibraryServiceError({
        code: 'not-ready',
        message: 'library service supervisor has not been opened',
        retryable: false,
      });
    if (this.#phase === 'ready') return this.#version!;
    if (this.#connecting) return this.#connecting;
    this.#automaticRestartsLeft = this.#maxAutomaticRestarts;
    this.#failure = undefined;
    return this.#beginConnection(true);
  }

  /**
   * Replace a shared transport that another logical channel found unusable.
   *
   * Content and library live on one physical Worker. Once the library has claimed that Worker, only this
   * supervisor may advance its generation: it must reopen the encrypted authority and restore subscriptions before
   * content can use the replacement. This is automatic recovery, so it observes the same restart budget as a
   * failure reported by the library channel itself.
   */
  async recoverSharedTransport(): Promise<LibraryVersion> {
    this.#assertNotClosed();
    if (!this.#openOptions)
      throw new LibraryServiceError({
        code: 'not-ready',
        message: 'library service supervisor has not been opened',
        retryable: false,
      });
    if (this.#connecting) return this.#connecting;
    if (this.#phase !== 'ready' || !this.#active) {
      if (this.#failure) throw new LibraryServiceError(this.#failure);
      throw new LibraryServiceError({
        code: 'not-ready',
        message: 'library service is not ready',
        retryable: true,
      });
    }
    if (this.#automaticRestartsLeft === 0) {
      const failure: LibraryServiceFailure = {
        code: 'unavailable',
        message: 'shared Worker transport is unavailable',
        retryable: true,
      };
      this.#setFailed(failure);
      throw new LibraryServiceError(failure);
    }
    this.#automaticRestartsLeft--;
    startupMark(
      'supervisor restart',
      `shared transport unusable; restarts left ${this.#automaticRestartsLeft}`,
    );
    this.#disposeActive();
    return this.#beginConnection(true);
  }

  async command(
    command: LibraryCommand,
    operationId: string = crypto.randomUUID(),
  ): Promise<LibraryServiceCommandResult> {
    return this.#semantic((client) => client.command(command, operationId));
  }

  async query(
    query: LibraryQuery,
  ): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    return await this.#readyClient().query(query);
  }

  async task(
    task: LibraryTask,
    operationId: string = crypto.randomUUID(),
  ): Promise<{ result: LibraryTaskResult; version: LibraryVersion }> {
    return this.#semantic((client) => client.task(task, operationId));
  }

  async observe(observation: LibraryObservation): Promise<LibraryVersion> {
    const active = this.#active;
    const version = await this.#readyClient().observe(observation);
    if (active === this.#active && this.#phase === 'ready')
      this.#observations.set(observationKey(observation), structuredClone(observation));
    return version;
  }

  async subscribe(
    selection: LibrarySelection,
    listener: (value: LibrarySelectionValue, version: LibraryVersion) => void,
  ): Promise<() => void> {
    return this.subscribeSnapshot(selection, (snapshot) => {
      if (snapshot.connection === 'ready' && snapshot.value && snapshot.version)
        listener(snapshot.value, snapshot.version);
    });
  }

  subscribeSnapshot(
    selection: LibrarySelection,
    listener: (snapshot: LibrarySelectionSnapshot) => void,
  ): () => void {
    this.#assertNotClosed();
    const id = ++this.#nextSubscription;
    const connection = this.#selectionConnection();
    const subscription: Subscription = {
      selection: structuredClone(selection),
      listener,
      required: this.#openOptions === undefined,
      snapshot: {
        selection: structuredClone(selection),
        connection,
        ...(this.#failure ? { error: this.#failure } : {}),
      },
    };
    this.#subscriptions.set(id, subscription);
    this.#notifySubscription(subscription);

    const active = this.#active;
    if (this.#phase === 'ready' && active)
      void this.#bindSubscription(id, subscription, active).catch((error: unknown) => {
        if (this.#subscriptions.get(id) !== subscription || active !== this.#active) return;
        const failure = failureFrom(error);
        this.#replaceSnapshot(subscription, 'failed', failure);
      });

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      if (this.#subscriptions.get(id) !== subscription) return;
      this.#subscriptions.delete(id);
      subscription.stopClient?.();
    };
  }

  onStatus(listener: (status: LibrarySessionStatus) => void): () => void {
    if (this.#phase === 'closed') return () => {};
    this.#statusListeners.add(listener);
    if (this.#lastStatus) this.#notifyStatusListener(listener, this.#lastStatus);
    return () => this.#statusListeners.delete(listener);
  }

  close(): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    this.#disposeActive();
    this.#subscriptions.clear();
    this.#statusListeners.clear();
  }

  #beginConnection(reconnecting: boolean): Promise<LibraryVersion> {
    this.#phase = reconnecting ? 'reconnecting' : 'connecting';
    if (reconnecting) {
      this.#markSubscriptions('reconnecting');
      this.#emitStatus({ kind: 'reconnecting', version: this.#version ?? null });
    }
    const connecting = this.#connectWithRetry();
    this.#connecting = connecting;
    void connecting.then(
      () => {
        if (this.#connecting === connecting) this.#connecting = undefined;
      },
      () => {
        if (this.#connecting === connecting) this.#connecting = undefined;
      },
    );
    return connecting;
  }

  async #connectWithRetry(): Promise<LibraryVersion> {
    await this.#openKnownProfileHousehold();
    while (true) {
      try {
        const version = await this.#connectOnce();
        if (this.#bootstrapped) {
          this.#bootstrapped = false;
          this.#onProfileHouseholdBootstrapped(this.#openOptions!.libraryKey);
        }
        return version;
      } catch (error) {
        const failure = failureFrom(error);
        this.#disposeActive();
        if (this.#phase === 'closed') throw new LibraryServiceError(failure);
        if (await this.#bootstrapProfileHousehold(failure)) continue;
        if (!failure.retryable || this.#automaticRestartsLeft === 0) {
          this.#setFailed(failure);
          throw new LibraryServiceError(failure);
        }
        this.#automaticRestartsLeft--;
        startupMark(
          'supervisor restart',
          `${startupFailure(error)}; restarts left ${this.#automaticRestartsLeft}`,
        );
        this.#phase = 'reconnecting';
        this.#markSubscriptions('reconnecting');
        this.#emitStatus({ kind: 'reconnecting', version: this.#version ?? null });
      }
    }
  }

  async #connectOnce(): Promise<LibraryVersion> {
    const client = this.createClient();
    const token = ++this.#nextToken;
    const active: ActiveClient = {
      client,
      token,
      stopStatus: () => {},
    };
    active.stopStatus = client.onStatus((status) => this.#receiveStatus(active, status));
    this.#active = active;

    const helloAt = performance.now();
    let version = await client.open(this.#openOptions!);
    startupMark('worker ready', `hello answered in ${Math.round(performance.now() - helloAt)}ms`);
    active.version = version;
    if (this.#active !== active || active.failure)
      throw new LibraryServiceError(
        active.failure ?? {
          code: 'cancelled',
          message: 'library service connection was replaced',
          retryable: false,
        },
      );

    for (const observation of this.#observations.values()) {
      version = await client.observe(observation);
      active.version = newerVersion(active.version, version);
      if (this.#active !== active || active.failure)
        throw new LibraryServiceError(
          active.failure ?? {
            code: 'cancelled',
            message: 'library service connection was replaced',
            retryable: false,
          },
        );
    }

    // A retained route can acquire another selection while the initial Worker replies are still arriving. Drain
    // every subscription added during that wait before publishing ready; once a pass finds none, JavaScript cannot
    // interleave another subscriber before the synchronous phase change below.
    for (;;) {
      const unbound = [...this.#subscriptions].filter(
        ([, subscription]) => subscription.attemptedToken !== active.token,
      );
      if (!unbound.length) break;
      await Promise.all(
        unbound.map(async ([id, subscription]) => {
          try {
            await this.#bindSubscription(id, subscription, active);
          } catch (error) {
            if (subscription.required) throw error;
            if (this.#active !== active || this.#subscriptions.get(id) !== subscription) return;
            this.#replaceSnapshot(subscription, 'failed', failureFrom(error));
          }
        }),
      );
    }
    if (this.#active !== active || active.failure)
      throw new LibraryServiceError(
        active.failure ?? {
          code: 'cancelled',
          message: 'library service connection was replaced',
          retryable: false,
        },
      );

    this.#phase = 'ready';
    const readyVersion = active.version ?? version;
    this.#version = readyVersion;
    this.#failure = undefined;
    this.#automaticRestartsLeft = this.#maxAutomaticRestarts;
    // Initial Worker replies can arrive in separate page tasks. Keep their complete replacement snapshots private
    // until every subscription is bound, then expose the connection in one synchronous publication turn.
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.staged?.token !== active.token) continue;
      subscription.snapshot = subscription.staged.snapshot;
      subscription.staged = undefined;
      this.#notifySubscription(subscription);
    }
    startupMark('supervisor ready', `${this.#subscriptions.size} subscriptions bound`);
    this.#emitStatus({ kind: 'ready', version: readyVersion });
    return readyVersion;
  }

  async #bindSubscription(
    id: number,
    subscription: Subscription,
    active: ActiveClient,
  ): Promise<void> {
    subscription.stopClient?.();
    subscription.stopClient = undefined;
    subscription.seenToken = undefined;
    subscription.attemptedToken = active.token;
    const stop = await active.client.subscribe(subscription.selection, (value, version) => {
      if (this.#active !== active || this.#subscriptions.get(id) !== subscription) return;
      subscription.seenToken = active.token;
      active.version = newerVersion(active.version, version);
      this.#version = newerVersion(this.#version, version);
      const snapshot: LibrarySelectionSnapshot = {
        selection: subscription.selection,
        connection: 'ready',
        value,
        version,
      };
      if (this.#phase === 'ready') {
        subscription.snapshot = snapshot;
        this.#notifySubscription(subscription);
      } else subscription.staged = { token: active.token, snapshot };
    });
    if (this.#active !== active || this.#subscriptions.get(id) !== subscription) {
      stop();
      return;
    }
    if (subscription.seenToken !== active.token) {
      stop();
      throw new LibraryServiceError({
        code: 'internal',
        message: 'library service subscribed without an initial replacement',
        retryable: false,
      });
    }
    subscription.stopClient = stop;
  }

  #receiveStatus(active: ActiveClient, status: LibrarySessionStatus): void {
    if (this.#active !== active) return;
    if (status.kind === 'failed') {
      active.failure = status.error;
      if (this.#phase === 'connecting' || this.#phase === 'reconnecting') return;
      this.#disposeActive();
      if (this.#canBootstrapProfileHousehold(status.error)) {
        startupMark('supervisor household bootstrap', 'wire 4 needs an upgrade to wire 5');
        this.#phase = 'reconnecting';
        this.#markSubscriptions('reconnecting');
        this.#emitStatus({ kind: 'reconnecting', version: this.#version ?? null });
        void this.#bootstrapProfileHousehold(status.error).then((enabled) => {
          if (this.#phase === 'closed') return;
          if (enabled) void this.#beginConnection(true).catch(() => undefined);
          else this.#setFailed(status.error);
        });
        return;
      }
      if (!status.error.retryable || this.#automaticRestartsLeft === 0) {
        this.#setFailed(status.error);
        return;
      }
      this.#automaticRestartsLeft--;
      startupMark(
        'supervisor restart',
        `${startupFailure({ failure: status.error })}; restarts left ${this.#automaticRestartsLeft}`,
      );
      void this.#beginConnection(true).catch(() => undefined);
      return;
    }
    if (
      (this.#phase === 'connecting' || this.#phase === 'reconnecting') &&
      (status.kind === 'ready' || status.kind === 'reconnecting')
    )
      return;
    if (status.kind === 'reconnecting') this.#markSubscriptions('reconnecting');
    if (status.kind === 'ready') this.#markSubscriptionsReady();
    this.#emitStatus(status);
  }

  #canBootstrapProfileHousehold(failure: LibraryServiceFailure): boolean {
    return (
      failure.code === 'update-required' &&
      failure.retryable === false &&
      failure.requiredWire === 5 &&
      this.#openOptions?.mode === 'online' &&
      (this.#openOptions.wire ?? 4) === 4 &&
      this.#openOptions.bootstrapProfileHousehold === true
    );
  }

  /**
   * A household this browser has seen bootstrapped skips the wire-4 refusal: the Owner split is one-way, so it still
   * needs wire 5. The host's capability stays the authority, as for the bootstrap itself.
   */
  async #openKnownProfileHousehold(): Promise<void> {
    const options = this.#openOptions;
    if (
      options?.mode !== 'online' ||
      (options.wire ?? 4) !== 4 ||
      options.bootstrapProfileHousehold !== true
    )
      return;
    let enabled = false;
    try {
      enabled =
        (await this.#knownProfileHousehold(options.libraryKey)) &&
        (await this.#profileHouseholdEnabled());
    } catch {
      // Fail closed: the household opens on wire 4 and bootstraps from den-edge's answer.
    }
    if (this.#phase === 'closed')
      throw new LibraryServiceError({
        code: 'cancelled',
        message: 'library service supervisor was closed',
        retryable: false,
      });
    if (!enabled || this.#openOptions !== options) return;
    startupMark('supervisor household bootstrap', 'opening a known household on wire 5');
    this.#openOptions = { ...options, wire: 5, bootstrapProfileHousehold: false };
  }

  async #bootstrapProfileHousehold(failure: LibraryServiceFailure): Promise<boolean> {
    if (!this.#canBootstrapProfileHousehold(failure)) return false;
    let enabled = false;
    try {
      enabled = await this.#profileHouseholdEnabled();
    } catch {
      // Host capability discovery is fail-closed. The original authenticated 426 remains authoritative.
    }
    if (!enabled || !this.#openOptions) return false;
    startupMark('supervisor household bootstrap', 'reopening on wire 5');
    this.#openOptions = {
      ...this.#openOptions,
      wire: 5,
      bootstrapProfileHousehold: false,
    };
    this.#bootstrapped = true;
    this.#automaticRestartsLeft = this.#maxAutomaticRestarts;
    return true;
  }

  #disposeActive(): void {
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    active.stopStatus();
    active.client.close();
    for (const subscription of this.#subscriptions.values()) {
      subscription.stopClient = undefined;
      subscription.seenToken = undefined;
      subscription.attemptedToken = undefined;
      if (subscription.staged?.token === active.token) subscription.staged = undefined;
    }
  }

  #setFailed(failure: LibraryServiceFailure): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'failed';
    this.#failure = failure;
    startupMark('supervisor failed', startupFailure({ failure }));
    this.#disposeActive();
    this.#markSubscriptions('failed', failure);
    this.#emitStatus({ kind: 'failed', error: failure });
  }

  #markSubscriptions(
    connection: Extract<LibrarySelectionConnection, 'reconnecting' | 'failed'>,
    error?: LibraryServiceFailure,
  ): void {
    for (const subscription of this.#subscriptions.values())
      this.#replaceSnapshot(subscription, connection, error);
  }

  #markSubscriptionsReady(): void {
    for (const subscription of this.#subscriptions.values()) {
      if (!subscription.snapshot.value || !subscription.snapshot.version) continue;
      this.#replaceSnapshot(subscription, 'ready');
    }
  }

  #replaceSnapshot(
    subscription: Subscription,
    connection: LibrarySelectionConnection,
    error?: LibraryServiceFailure,
  ): void {
    subscription.snapshot = {
      selection: subscription.selection,
      connection,
      ...(subscription.snapshot.value ? { value: subscription.snapshot.value } : {}),
      ...(subscription.snapshot.version ? { version: subscription.snapshot.version } : {}),
      ...(error ? { error } : {}),
    };
    this.#notifySubscription(subscription);
  }

  #selectionConnection(): LibrarySelectionConnection {
    if (this.#phase === 'ready') return 'connecting';
    if (this.#phase === 'reconnecting') return 'reconnecting';
    if (this.#phase === 'failed') return 'failed';
    return 'connecting';
  }

  #readyClient(): LibraryServiceClientPort {
    this.#assertNotClosed();
    if (this.#phase === 'ready' && this.#active) return this.#active.client;
    if (this.#failure) throw new LibraryServiceError(this.#failure);
    throw new LibraryServiceError({
      code: 'not-ready',
      message: 'library service is not ready',
      retryable: true,
    });
  }

  /** Replay only after this exact client was replaced; the durable operation ID makes a lost reply safe. */
  async #semantic<T>(send: (client: LibraryServiceClientPort) => Promise<T>): Promise<T> {
    for (;;) {
      const active = this.#active;
      const client = this.#readyClient();
      try {
        return await send(client);
      } catch (error) {
        // A transport may reject its pending request immediately before its failure status reaches us.
        await Promise.resolve();
        const failure = failureFrom(error);
        if (
          !failure.retryable ||
          this.#phase === 'closed' ||
          (active === this.#active && this.#phase === 'ready')
        )
          throw error;
        const reconnecting = this.#connecting;
        if (!reconnecting) throw error;
        await reconnecting;
      }
    }
  }

  #assertNotClosed(): void {
    if (this.#phase === 'closed')
      throw new LibraryServiceError({
        code: 'cancelled',
        message: 'library service supervisor is closed',
        retryable: false,
      });
  }

  #notifySubscription(subscription: Subscription): void {
    try {
      subscription.listener(subscription.snapshot);
    } catch (error) {
      console.error('den: a supervised library subscription listener failed', error);
    }
  }

  #emitStatus(status: LibrarySessionStatus): void {
    this.#lastStatus = status;
    for (const listener of this.#statusListeners) this.#notifyStatusListener(listener, status);
  }

  #notifyStatusListener(
    listener: (status: LibrarySessionStatus) => void,
    status: LibrarySessionStatus,
  ): void {
    try {
      listener(status);
    } catch (error) {
      console.error('den: a supervised library status listener failed', error);
    }
  }
}

function failureFrom(error: unknown): LibraryServiceFailure {
  if (error instanceof LibraryServiceError) return error.failure;
  return {
    code: 'unavailable',
    message: error instanceof Error ? error.message : 'library service is unavailable',
    retryable: true,
  };
}

function observationKey(observation: LibraryObservation): string {
  if (observation.kind === 'lifecycle') return 'lifecycle';
  if (observation.kind === 'foreground-ready') return 'foreground-ready';
  return `title-shape:${observation.title.type}:${observation.title.id}`;
}

function newerVersion(
  current: LibraryVersion | undefined,
  candidate: LibraryVersion,
): LibraryVersion {
  if (
    !current ||
    current.instance !== candidate.instance ||
    current.generation !== candidate.generation ||
    candidate.revision > current.revision
  )
    return candidate;
  return current;
}

function sameOpenOptions(
  left: LibraryServiceOpenOptions,
  right: LibraryServiceOpenOptions,
): boolean {
  if (
    left.libraryKey !== right.libraryKey ||
    left.mode !== right.mode ||
    (left.wire ?? 4) !== (right.wire ?? 4) ||
    left.bootstrapProfileHousehold !== right.bootstrapProfileHousehold
  )
    return false;
  if ((left.legacyClock === undefined) !== (right.legacyClock === undefined)) return false;
  if (left.legacyClock?.device !== right.legacyClock?.device) return false;
  const leftLast = left.legacyClock?.last;
  const rightLast = right.legacyClock?.last;
  if (!leftLast || !rightLast) return leftLast === rightLast;
  return (
    leftLast[0] === rightLast[0] && leftLast[1] === rightLast[1] && leftLast[2] === rightLast[2]
  );
}
