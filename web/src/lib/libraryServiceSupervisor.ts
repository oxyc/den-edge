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
  stopClient?: () => void;
  seenToken?: number;
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
  #automaticRestartsLeft: number;
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
    this.#openOptions = structuredClone(options);
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
    while (true) {
      try {
        return await this.#connectOnce();
      } catch (error) {
        const failure = failureFrom(error);
        this.#disposeActive();
        if (this.#phase === 'closed') throw new LibraryServiceError(failure);
        if (!failure.retryable || this.#automaticRestartsLeft === 0) {
          this.#setFailed(failure);
          throw new LibraryServiceError(failure);
        }
        this.#automaticRestartsLeft--;
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

    let version = await client.open(this.#openOptions!);
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

    await Promise.all(
      [...this.#subscriptions].map(([id, subscription]) =>
        this.#bindSubscription(id, subscription, active),
      ),
    );
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
    const stop = await active.client.subscribe(subscription.selection, (value, version) => {
      if (this.#active !== active || this.#subscriptions.get(id) !== subscription) return;
      subscription.seenToken = active.token;
      active.version = newerVersion(active.version, version);
      this.#version = newerVersion(this.#version, version);
      subscription.snapshot = {
        selection: subscription.selection,
        connection: 'ready',
        value,
        version,
      };
      this.#notifySubscription(subscription);
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
      if (!status.error.retryable || this.#automaticRestartsLeft === 0) {
        this.#setFailed(status.error);
        return;
      }
      this.#automaticRestartsLeft--;
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

  #disposeActive(): void {
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    active.stopStatus();
    active.client.close();
    for (const subscription of this.#subscriptions.values()) {
      subscription.stopClient = undefined;
      subscription.seenToken = undefined;
    }
  }

  #setFailed(failure: LibraryServiceFailure): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'failed';
    this.#failure = failure;
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
  if (left.libraryKey !== right.libraryKey || left.mode !== right.mode) return false;
  if ((left.legacyClock === undefined) !== (right.legacyClock === undefined)) return false;
  if (left.legacyClock?.device !== right.legacyClock?.device) return false;
  const leftLast = left.legacyClock?.last;
  const rightLast = right.legacyClock?.last;
  if (!leftLast || !rightLast) return leftLast === rightLast;
  return (
    leftLast[0] === rightLast[0] && leftLast[1] === rightLast[1] && leftLast[2] === rightLast[2]
  );
}
