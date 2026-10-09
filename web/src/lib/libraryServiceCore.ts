import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryCommand,
  type LibraryObservation,
  type LibraryQuery,
  type LibraryQueryResult,
  type LibrarySelection,
  type LibrarySelectionValue,
  type LibraryServiceClientMessage,
  type LibraryServiceError,
  type LibraryServiceErrorCode,
  type LibraryServiceFailure,
  type LibraryServiceHello,
  type LibraryServiceServerMessage,
  type LibrarySessionStatus,
  type LibraryTask,
  type LibraryTaskResult,
  type TitleRef,
  type LibraryVersion,
} from './libraryServiceProtocol';
import { decodeLibraryServiceClientMessage } from './libraryServiceProtocolCodec';

type Change = 'applied' | 'unchanged';
type CommandDelivery = 'synced' | 'queued' | 'local';

export type LibrarySelectionScope =
  | { kind: 'all' }
  | { kind: 'overview' }
  | { kind: 'continue' }
  | { kind: 'history' }
  | { kind: 'settings' }
  | { kind: 'connections' }
  | { kind: 'simkl' }
  | { kind: 'recovery' }
  | { kind: 'runtime' }
  | { kind: 'downloads' }
  | { kind: 'title'; title: TitleRef }
  | { kind: 'presence'; title: TitleRef };

export interface LibraryAuthorityCommandResult {
  outcome: Change;
  delivery: CommandDelivery;
  affected: LibrarySelectionScope[];
}

export interface LibraryAuthorityObservationResult {
  outcome: Change;
  affected: LibrarySelectionScope[];
}

export interface LibraryAuthorityTaskResult {
  result: LibraryTaskResult;
  affected: LibrarySelectionScope[];
}

/** The raw log stays behind this boundary. Tests and the eventual Worker host inject one exact authority. */
export interface LibraryServiceAuthority {
  readonly generation: string | null;
  select(selection: LibrarySelection): Promise<LibrarySelectionValue>;
  command(command: LibraryCommand, operationId: string): Promise<LibraryAuthorityCommandResult>;
  query(query: LibraryQuery): Promise<LibraryQueryResult>;
  task(task: LibraryTask, operationId: string): Promise<LibraryAuthorityTaskResult>;
  observe(observation: LibraryObservation): Promise<LibraryAuthorityObservationResult>;
  listen?(listener: (event: LibraryAuthorityEvent) => void): () => void;
  close?(): void | Promise<void>;
}

export type LibraryAuthorityEvent =
  | { kind: 'changed'; affected: LibrarySelectionScope[] }
  | { kind: 'status'; status: LibraryAuthorityStatus };

export type LibraryAuthorityStatus =
  | { kind: 'ready' }
  | { kind: 'reconnecting' }
  | { kind: 'read-only'; reason: string }
  | { kind: 'moved'; successor?: string }
  | { kind: 'failed'; error: LibraryServiceFailure };

export type LibraryAuthorityOpener = (
  request: LibraryServiceHello,
) => Promise<LibraryServiceAuthority | null>;

interface Subscription {
  selection: LibrarySelection;
  value: LibrarySelectionValue;
  digest: string;
}

interface CompletedOperation {
  command: string;
  outcome: Change;
  delivery: CommandDelivery;
  version: LibraryVersion;
}

const OPERATION_HISTORY_LIMIT = 1_024;

const failure = (
  code: LibraryServiceErrorCode,
  message: string,
  retryable = false,
): LibraryServiceFailure => ({ code, message, retryable });

/** A domain/storage refusal that the protocol must preserve instead of flattening into `internal`. */
export class LibraryServiceAuthorityError extends Error {
  constructor(readonly failure: LibraryServiceFailure) {
    super(failure.message);
    this.name = 'LibraryServiceAuthorityError';
  }
}

const authorityFailure = (error: unknown, fallback: string): LibraryServiceFailure =>
  error instanceof LibraryServiceAuthorityError
    ? error.failure
    : failure('internal', error instanceof Error ? error.message : fallback, true);

const requestIdOf = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const requestId = (input as Record<string, unknown>).requestId;
  return typeof requestId === 'string' && requestId.length ? requestId : undefined;
};

const digest = (value: LibrarySelectionValue): string => JSON.stringify(value);

function errorReply(
  error: LibraryServiceFailure,
  requestId?: string,
  subscriptionId?: string,
): LibraryServiceError {
  return {
    type: 'error',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    ...(requestId ? { requestId } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    error,
  };
}

/**
 * One serialized library actor. It owns protocol ordering, subscriptions and in-session command deduplication;
 * domain reads and writes stay in the injected authority so neither transport learns about durable rows.
 */
export class LibraryServiceCore {
  readonly #instance: string;
  readonly #subscriptions = new Map<string, Subscription>();
  /** In-instance replay protection; durable action idempotency remains the authority's responsibility. */
  readonly #operations = new Map<string, CompletedOperation>();
  readonly #listeners = new Set<(messages: LibraryServiceServerMessage[]) => void>();
  #authority?: LibraryServiceAuthority;
  #stopAuthority?: () => void;
  #client?: { id: string; libraryKey: string; mode: LibraryServiceHello['mode'] };
  #revision = 0;
  #closed = false;
  #requests: Promise<void> = Promise.resolve();
  readonly #providerWork = new Set<Promise<LibraryServiceServerMessage[]>>();

  constructor(
    private readonly openAuthority: LibraryAuthorityOpener,
    instance: string = crypto.randomUUID(),
  ) {
    this.#instance = instance;
  }

  /** Requests are processed in arrival order, including their selection replacements. */
  dispatch(input: unknown): Promise<LibraryServiceServerMessage[]> {
    // Metadata is remote provider work, not authority coordination. Start it after everything already admitted to
    // the actor, but do not occupy the lane while the network is in flight: commands and subscriptions remain live.
    if (isLibraryMetadataRequest(input)) {
      const admitted = this.#requests;
      const work = admitted.then(() => this.#dispatch(input));
      this.#providerWork.add(work);
      void work.finally(() => this.#providerWork.delete(work));
      return work;
    }
    let resolve!: (messages: LibraryServiceServerMessage[]) => void;
    const result = new Promise<LibraryServiceServerMessage[]>((done) => (resolve = done));
    this.#requests = this.#requests
      .then(async () => resolve(await this.#dispatch(input)))
      .catch((error: unknown) =>
        resolve([
          errorReply(
            failure(
              'internal',
              error instanceof Error ? error.message : 'library service request failed',
              true,
            ),
            requestIdOf(input),
          ),
        ]),
      );
    return result;
  }

  /** Out-of-band changes use the same ordered actor and version stream as requests. */
  listen(listener: (messages: LibraryServiceServerMessage[]) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Cancel queued work, then release the one authority after the actor has drained. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#requests;
    await Promise.allSettled([...this.#providerWork]);
    // A completed metadata query may have queued its shape replacement just before it observed `#closed`.
    await this.#requests;
    this.#subscriptions.clear();
    this.#operations.clear();
    this.#listeners.clear();
    this.#stopAuthority?.();
    this.#stopAuthority = undefined;
    const authority = this.#authority;
    this.#authority = undefined;
    await authority?.close?.();
  }

  async #dispatch(input: unknown): Promise<LibraryServiceServerMessage[]> {
    const decoded = decodeLibraryServiceClientMessage(input);
    if (!decoded.ok) return [errorReply(decoded.error, requestIdOf(input))];
    const request = decoded.value;
    if (this.#closed)
      return [errorReply(failure('cancelled', 'library service is closed'), request.requestId)];
    if (request.type === 'hello') return this.#hello(request);
    if (!this.#authority)
      return [
        errorReply(failure('not-ready', 'library service is not ready', true), request.requestId),
      ];

    try {
      switch (request.type) {
        case 'subscribe':
          return await this.#subscribe(request);
        case 'unsubscribe':
          this.#subscriptions.delete(request.subscriptionId);
          return [
            {
              type: 'unsubscribed',
              protocol: LIBRARY_SERVICE_PROTOCOL,
              requestId: request.requestId,
              subscriptionId: request.subscriptionId,
            },
          ];
        case 'command':
          return await this.#command(request);
        case 'query':
          return [
            {
              type: 'query-result',
              protocol: LIBRARY_SERVICE_PROTOCOL,
              requestId: request.requestId,
              result: await this.#authority.query(request.query),
              version: this.#version(),
            },
          ];
        case 'task': {
          const task = await this.#authority.task(request.task, request.operationId);
          this.#revision++;
          let updates: LibraryServiceServerMessage[] = [];
          try {
            updates = await this.#updates(task.affected);
          } catch {
            // The task is already complete; a later authority publication retries selector replacement.
          }
          return [
            ...updates,
            {
              type: 'task-result',
              protocol: LIBRARY_SERVICE_PROTOCOL,
              requestId: request.requestId,
              operationId: request.operationId,
              result: task.result,
              version: this.#version(),
            },
          ];
        }
        case 'observe':
          return await this.#observe(request);
      }
    } catch (error) {
      return [
        errorReply(
          authorityFailure(error, 'library service request failed'),
          request.requestId,
          request.type === 'subscribe' || request.type === 'unsubscribe'
            ? request.subscriptionId
            : undefined,
        ),
      ];
    }
  }

  async #hello(
    request: Extract<LibraryServiceClientMessage, { type: 'hello' }>,
  ): Promise<LibraryServiceServerMessage[]> {
    if (this.#client) {
      if (
        this.#client.id !== request.clientId ||
        this.#client.libraryKey !== request.libraryKey ||
        this.#client.mode !== request.mode
      )
        return [
          errorReply(
            failure('conflict', 'library service already belongs to another client'),
            request.requestId,
          ),
        ];
      return [
        {
          type: 'ready',
          protocol: LIBRARY_SERVICE_PROTOCOL,
          requestId: request.requestId,
          version: this.#version(),
        },
      ];
    }

    try {
      const authority = await this.openAuthority(request);
      if (!authority)
        return [
          errorReply(failure('not-found', 'library could not be opened', true), request.requestId),
        ];
      this.#authority = authority;
      this.#client = { id: request.clientId, libraryKey: request.libraryKey, mode: request.mode };
      this.#stopAuthority = authority.listen?.((event) => this.#enqueueAuthorityEvent(event));
      return [
        {
          type: 'ready',
          protocol: LIBRARY_SERVICE_PROTOCOL,
          requestId: request.requestId,
          version: this.#version(),
        },
      ];
    } catch (error) {
      return [
        errorReply(
          error instanceof LibraryServiceAuthorityError
            ? error.failure
            : failure(
                'unavailable',
                error instanceof Error ? error.message : 'library could not be opened',
                true,
              ),
          request.requestId,
        ),
      ];
    }
  }

  async #subscribe(
    request: Extract<LibraryServiceClientMessage, { type: 'subscribe' }>,
  ): Promise<LibraryServiceServerMessage[]> {
    const value = await this.#authority!.select(request.selection);
    this.#subscriptions.set(request.subscriptionId, {
      selection: request.selection,
      value,
      digest: digest(value),
    });
    const version = this.#version();
    return [
      {
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId: request.subscriptionId,
        version,
        value,
      },
      {
        type: 'subscribed',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: request.requestId,
        subscriptionId: request.subscriptionId,
        version,
      },
    ];
  }

  async #command(
    request: Extract<LibraryServiceClientMessage, { type: 'command' }>,
  ): Promise<LibraryServiceServerMessage[]> {
    const encoded = JSON.stringify(request.command);
    const completed = this.#operations.get(request.operationId);
    if (completed) {
      if (completed.command !== encoded)
        return [
          errorReply(
            failure('conflict', 'operationId was already used for another command'),
            request.requestId,
          ),
        ];
      return [
        {
          type: 'command-result',
          protocol: LIBRARY_SERVICE_PROTOCOL,
          requestId: request.requestId,
          operationId: request.operationId,
          outcome: completed.outcome,
          delivery: completed.delivery,
          version: completed.version,
        },
      ];
    }

    const { outcome, delivery, affected } = await this.#authority!.command(
      request.command,
      request.operationId,
    );
    if (outcome === 'applied') this.#revision++;
    const version = this.#version();
    this.#rememberOperation(request.operationId, {
      command: encoded,
      outcome,
      delivery,
      version,
    });
    let updates: LibraryServiceServerMessage[] = [];
    if (outcome === 'applied')
      try {
        updates = await this.#updates(affected);
      } catch {
        // The command is already durable. Leave every subscription digest unchanged so the next authority
        // publication retries the complete replacement set; never invite the caller to repeat the command.
      }
    return [
      ...updates,
      {
        type: 'command-result',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: request.requestId,
        operationId: request.operationId,
        outcome,
        delivery,
        version,
      },
    ];
  }

  async #observe(
    request: Extract<LibraryServiceClientMessage, { type: 'observe' }>,
  ): Promise<LibraryServiceServerMessage[]> {
    const { outcome, affected } = await this.#authority!.observe(request.observation);
    if (outcome === 'applied') this.#revision++;
    const version = this.#version();
    let updates: LibraryServiceServerMessage[] = [];
    if (outcome === 'applied')
      try {
        updates = await this.#updates(affected);
      } catch {
        // As above, the observation is installed even when a render-facing selector temporarily fails.
      }
    return [
      ...updates,
      {
        type: 'observed',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: request.requestId,
        version,
      },
    ];
  }

  async #updates(
    affected: readonly LibrarySelectionScope[],
  ): Promise<LibraryServiceServerMessage[]> {
    const version = this.#version();
    const staged: Array<{
      subscriptionId: string;
      subscription: Subscription;
      value: LibrarySelectionValue;
      digest: string;
    }> = [];
    for (const [subscriptionId, subscription] of this.#subscriptions) {
      if (!affected.some((scope) => scopeMatches(scope, subscription.selection))) continue;
      const value = await this.#authority!.select(subscription.selection);
      const nextDigest = digest(value);
      if (nextDigest === subscription.digest) continue;
      staged.push({ subscriptionId, subscription, value, digest: nextDigest });
    }
    for (const update of staged) {
      update.subscription.value = update.value;
      update.subscription.digest = update.digest;
    }
    return staged.map(({ subscriptionId, value }) => ({
      type: 'update',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      subscriptionId,
      version,
      value,
    }));
  }

  #enqueueAuthorityEvent(event: LibraryAuthorityEvent): void {
    this.#requests = this.#requests
      .then(async () => {
        if (this.#closed || !this.#authority) return;
        let messages: LibraryServiceServerMessage[];
        if (event.kind === 'status')
          messages = [
            {
              type: 'status',
              protocol: LIBRARY_SERVICE_PROTOCOL,
              status: this.#status(event.status),
            },
          ];
        else {
          this.#revision++;
          try {
            messages = await this.#updates(event.affected);
          } catch {
            return;
          }
        }
        if (!messages.length) return;
        for (const listener of this.#listeners)
          try {
            listener(messages);
          } catch (error) {
            console.error('den: a library service listener failed', error);
          }
      })
      .catch(() => undefined);
  }

  #status(status: LibraryAuthorityStatus): LibrarySessionStatus {
    if (status.kind === 'ready') return { kind: 'ready', version: this.#version() };
    if (status.kind === 'reconnecting') return { kind: 'reconnecting', version: this.#version() };
    if (status.kind === 'read-only')
      return { kind: 'read-only', version: this.#version(), reason: status.reason };
    if (status.kind === 'moved')
      return { kind: 'moved', ...(status.successor ? { successor: status.successor } : {}) };
    return status;
  }

  #rememberOperation(operationId: string, completed: CompletedOperation): void {
    this.#operations.set(operationId, completed);
    if (this.#operations.size <= OPERATION_HISTORY_LIMIT) return;
    this.#operations.delete(this.#operations.keys().next().value!);
  }

  #version(): LibraryVersion {
    return {
      instance: this.#instance,
      generation: this.#authority?.generation ?? null,
      revision: this.#revision,
    };
  }
}

function sameTitle(a: TitleRef, b: TitleRef): boolean {
  return a.type === b.type && a.id === b.id;
}

function isLibraryMetadataRequest(
  input: unknown,
): input is Extract<LibraryServiceClientMessage, { type: 'query' }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const request = input as { type?: unknown; query?: { kind?: unknown } };
  return request.type === 'query' && request.query?.kind === 'library.metadata';
}

function scopeMatches(scope: LibrarySelectionScope, selection: LibrarySelection): boolean {
  if (scope.kind === 'all') return true;
  if (
    scope.kind === 'overview' ||
    scope.kind === 'continue' ||
    scope.kind === 'history' ||
    scope.kind === 'settings' ||
    scope.kind === 'connections' ||
    scope.kind === 'simkl' ||
    scope.kind === 'recovery' ||
    scope.kind === 'runtime' ||
    scope.kind === 'downloads'
  )
    return selection.kind === scope.kind;
  if (scope.kind === 'title')
    return selection.kind === 'title' && sameTitle(scope.title, selection.title);
  return (
    selection.kind === 'presence' && selection.titles.some((title) => sameTitle(scope.title, title))
  );
}
