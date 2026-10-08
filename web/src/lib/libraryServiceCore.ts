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
  type LibraryServiceServerMessage,
  type LibraryVersion,
} from './libraryServiceProtocol';
import { decodeLibraryServiceClientMessage } from './libraryServiceProtocolCodec';

type Change = 'applied' | 'unchanged';
type CommandDelivery = 'synced' | 'queued' | 'local';

interface AuthorityCommandResult {
  outcome: Change;
  delivery: CommandDelivery;
}

/** The raw log stays behind this boundary. Tests and the eventual Worker host inject one exact authority. */
interface LibraryAuthority {
  readonly generation: string | null;
  select(selection: LibrarySelection): Promise<LibrarySelectionValue>;
  command(command: LibraryCommand, operationId: string): Promise<AuthorityCommandResult>;
  query(query: LibraryQuery): Promise<LibraryQueryResult>;
  observe(observation: LibraryObservation): Promise<Change>;
  close?(): void | Promise<void>;
}

type OpenAuthority = (libraryKey: string) => Promise<LibraryAuthority | null>;

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
  #authority?: LibraryAuthority;
  #client?: { id: string; libraryKey: string };
  #revision = 0;
  #closed = false;
  #requests: Promise<void> = Promise.resolve();

  constructor(
    private readonly openAuthority: OpenAuthority,
    instance: string = crypto.randomUUID(),
  ) {
    this.#instance = instance;
  }

  /** Requests are processed in arrival order, including their selection replacements. */
  dispatch(input: unknown): Promise<LibraryServiceServerMessage[]> {
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

  /** Cancel queued work, then release the one authority after the actor has drained. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#requests;
    this.#subscriptions.clear();
    this.#operations.clear();
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
          return this.#subscribe(request);
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
          return this.#command(request);
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
        case 'observe':
          return this.#observe(request);
      }
    } catch (error) {
      return [
        errorReply(
          failure(
            'internal',
            error instanceof Error ? error.message : 'library service request failed',
            true,
          ),
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
      if (this.#client.id !== request.clientId || this.#client.libraryKey !== request.libraryKey)
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
      const authority = await this.openAuthority(request.libraryKey);
      if (!authority)
        return [
          errorReply(failure('not-found', 'library could not be opened', true), request.requestId),
        ];
      this.#authority = authority;
      this.#client = { id: request.clientId, libraryKey: request.libraryKey };
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
          failure(
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

    const { outcome, delivery } = await this.#authority!.command(
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
    return [
      ...(outcome === 'applied' ? await this.#updates() : []),
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
    const outcome = await this.#authority!.observe(request.observation);
    if (outcome === 'applied') this.#revision++;
    const version = this.#version();
    return [
      ...(outcome === 'applied' ? await this.#updates() : []),
      {
        type: 'observed',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: request.requestId,
        version,
      },
    ];
  }

  async #updates(): Promise<LibraryServiceServerMessage[]> {
    const version = this.#version();
    const updates: LibraryServiceServerMessage[] = [];
    for (const [subscriptionId, subscription] of this.#subscriptions) {
      const value = await this.#authority!.select(subscription.selection);
      const nextDigest = digest(value);
      if (nextDigest === subscription.digest) continue;
      subscription.value = value;
      subscription.digest = nextDigest;
      updates.push({
        type: 'update',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        subscriptionId,
        version,
        value,
      });
    }
    return updates;
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
