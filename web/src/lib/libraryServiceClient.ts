import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryCommand,
  type LibraryObservation,
  type LibraryQuery,
  type LibraryQueryResult,
  type LibrarySelection,
  type LibrarySelectionValue,
  type LibraryServiceClientMessage,
  type LibraryServiceCommandResult,
  type LibraryServiceFailure,
  type LibraryServiceHello,
  type LibraryServiceServerMessage,
  type LibraryTask,
  type LibraryTaskResult,
  type LibrarySessionStatus,
  type LibraryVersion,
} from './libraryServiceProtocol';
import { decodeLibraryServiceServerMessage } from './libraryServiceProtocolCodec';

export interface LibraryServiceTransport {
  send(message: LibraryServiceClientMessage): void;
  listen(listener: (message: unknown) => void): () => void;
  close(): void;
}

export type LibraryServiceOpenOptions = Pick<
  LibraryServiceHello,
  'libraryKey' | 'mode' | 'legacyClock'
>;

type Pending = {
  request: LibraryServiceClientMessage;
  resolve: (message: LibraryServiceServerMessage) => void;
  reject: (error: LibraryServiceError) => void;
};

type Subscription = {
  selection: LibrarySelection;
  listener: (value: LibrarySelectionValue, version: LibraryVersion) => void;
  version?: LibraryVersion;
};

export class LibraryServiceError extends Error {
  constructor(readonly failure: LibraryServiceFailure) {
    super(failure.message);
    this.name = 'LibraryServiceError';
  }
}

/** Transport-neutral client for immutable library views and semantic commands. */
export class LibraryServiceClient {
  readonly #pending = new Map<string, Pending>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #statusListeners = new Set<(status: LibrarySessionStatus) => void>();
  readonly #stopListening: () => void;
  #nextRequest = 0;
  #nextSubscription = 0;
  #instance?: string;
  #closed = false;

  constructor(
    private readonly transport: LibraryServiceTransport,
    private readonly clientId: string = crypto.randomUUID(),
  ) {
    this.#stopListening = transport.listen((message) => this.#receive(message));
  }

  async open(options: LibraryServiceOpenOptions): Promise<LibraryVersion> {
    const requestId = this.#requestId();
    const reply = await this.#request({
      type: 'hello',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId,
      clientId: this.clientId,
      ...options,
    });
    if (reply.type !== 'ready') throw this.#unexpected(reply, 'ready');
    this.#instance = reply.version.instance;
    return reply.version;
  }

  async command(
    command: LibraryCommand,
    operationId: string = crypto.randomUUID(),
  ): Promise<LibraryServiceCommandResult> {
    const requestId = this.#requestId();
    const reply = await this.#request({
      type: 'command',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId,
      operationId,
      command,
    });
    if (reply.type !== 'command-result') throw this.#unexpected(reply, 'command-result');
    return reply;
  }

  async query(
    query: LibraryQuery,
  ): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    const requestId = this.#requestId();
    const reply = await this.#request({
      type: 'query',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId,
      query,
    });
    if (reply.type !== 'query-result') throw this.#unexpected(reply, 'query-result');
    return { result: reply.result, version: reply.version };
  }

  async task(task: LibraryTask): Promise<{ result: LibraryTaskResult; version: LibraryVersion }> {
    const requestId = this.#requestId();
    const reply = await this.#request({
      type: 'task',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId,
      task,
    });
    if (reply.type !== 'task-result') throw this.#unexpected(reply, 'task-result');
    return { result: reply.result, version: reply.version };
  }

  async observe(observation: LibraryObservation): Promise<LibraryVersion> {
    const requestId = this.#requestId();
    const reply = await this.#request({
      type: 'observe',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId,
      observation,
    });
    if (reply.type !== 'observed') throw this.#unexpected(reply, 'observed');
    return reply.version;
  }

  async subscribe(
    selection: LibrarySelection,
    listener: (value: LibrarySelectionValue, version: LibraryVersion) => void,
  ): Promise<() => void> {
    this.#assertOpen();
    const subscriptionId = `subscription-${++this.#nextSubscription}`;
    this.#subscriptions.set(subscriptionId, { selection, listener });
    const requestId = this.#requestId();
    try {
      const reply = await this.#request({
        type: 'subscribe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId,
        subscriptionId,
        selection,
      });
      if (reply.type !== 'subscribed') throw this.#unexpected(reply, 'subscribed');
    } catch (error) {
      this.#subscriptions.delete(subscriptionId);
      throw error;
    }
    let subscribed = true;
    return () => {
      if (!subscribed || this.#closed) return;
      subscribed = false;
      this.#subscriptions.delete(subscriptionId);
      const unsubscribeId = this.#requestId();
      void this.#request({
        type: 'unsubscribe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: unsubscribeId,
        subscriptionId,
      }).catch(() => undefined);
    };
  }

  onStatus(listener: (status: LibrarySessionStatus) => void): () => void {
    if (this.#closed) return () => {};
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopListening();
    this.transport.close();
    const error = new LibraryServiceError({
      code: 'cancelled',
      message: 'library service client is closed',
      retryable: false,
    });
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#subscriptions.clear();
    this.#statusListeners.clear();
  }

  #request(message: LibraryServiceClientMessage): Promise<LibraryServiceServerMessage> {
    this.#assertOpen();
    return new Promise((resolve, reject) => {
      this.#pending.set(message.requestId, { request: message, resolve, reject });
      try {
        this.transport.send(message);
      } catch (error) {
        this.#pending.delete(message.requestId);
        reject(error);
      }
    });
  }

  #receive(input: unknown): void {
    if (this.#closed) return;
    const decoded = decodeLibraryServiceServerMessage(input);
    if (!decoded.ok) {
      this.#failAll(decoded.error);
      return;
    }
    const message = decoded.value;
    if (message.type === 'update') {
      const subscription = this.#subscriptions.get(message.subscriptionId);
      if (
        !subscription ||
        message.version.instance !== this.#instance ||
        !newer(message.version, subscription.version)
      )
        return;
      if (!selectionMatches(subscription.selection, message.value)) {
        this.#failAll({
          code: 'invalid-request',
          message: 'library service returned the wrong selection value',
          retryable: false,
        });
        return;
      }
      subscription.version = message.version;
      try {
        subscription.listener(message.value, message.version);
      } catch (error) {
        console.error('den: a library subscription listener failed', error);
      }
      return;
    }
    if (message.type === 'status') {
      for (const listener of this.#statusListeners)
        try {
          listener(message.status);
        } catch (error) {
          console.error('den: a library status listener failed', error);
        }
      return;
    }
    if (message.type === 'error' && message.requestId) {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      this.#pending.delete(message.requestId);
      pending.reject(new LibraryServiceError(message.error));
      return;
    }
    if (message.type === 'error') {
      this.#failAll(message.error);
      return;
    }
    if (!('requestId' in message)) return;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    if (!replyMatches(pending.request, message, this.#instance)) {
      this.#pending.delete(message.requestId);
      const failure: LibraryServiceFailure = {
        code: 'invalid-request',
        message: 'library service reply did not match its request',
        retryable: false,
      };
      pending.reject(new LibraryServiceError(failure));
      this.#failAll(failure);
      return;
    }
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #failAll(failure: LibraryServiceFailure): void {
    const error = new LibraryServiceError(failure);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const listener of this.#statusListeners)
      try {
        listener({ kind: 'failed', error: failure });
      } catch (listenerError) {
        console.error('den: a library status listener failed', listenerError);
      }
  }

  #requestId(): string {
    return `${this.clientId}:${++this.#nextRequest}`;
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new LibraryServiceError({
        code: 'cancelled',
        message: 'library service client is closed',
        retryable: false,
      });
  }

  #unexpected(message: LibraryServiceServerMessage, expected: string): LibraryServiceError {
    return new LibraryServiceError({
      code: 'internal',
      message: `library service returned ${message.type}; expected ${expected}`,
      retryable: false,
    });
  }
}

function newer(candidate: LibraryVersion, current: LibraryVersion | undefined): boolean {
  if (!current) return true;
  if (candidate.instance !== current.instance) return false;
  return candidate.revision > current.revision;
}

function selectionMatches(selection: LibrarySelection, value: LibrarySelectionValue): boolean {
  if (selection.kind === 'overview') return value.kind === 'overview';
  if (selection.kind === 'continue') return value.kind === 'continue';
  if (selection.kind === 'history') return value.kind === 'history';
  if (selection.kind === 'settings') return value.kind === 'settings';
  if (selection.kind === 'connections') return value.kind === 'connections';
  if (selection.kind === 'simkl') return value.kind === 'simkl';
  if (selection.kind === 'recovery') return value.kind === 'recovery';
  if (selection.kind === 'runtime') return value.kind === 'runtime';
  if (selection.kind === 'downloads') return value.kind === 'downloads';
  if (selection.kind === 'presence')
    return (
      value.kind === 'presence' &&
      value.items.length === selection.titles.length &&
      value.items.every((item, index) => {
        const title = selection.titles[index];
        return title?.type === item.title.type && title.id === item.title.id;
      })
    );
  return (
    value.kind === 'title' &&
    value.title.type === selection.title.type &&
    value.title.id === selection.title.id
  );
}

function replyMatches(
  request: LibraryServiceClientMessage,
  reply: LibraryServiceServerMessage,
  instance: string | undefined,
): boolean {
  if ('version' in reply && instance && reply.version.instance !== instance) return false;
  if (request.type === 'hello') return reply.type === 'ready';
  if (request.type === 'command')
    return reply.type === 'command-result' && reply.operationId === request.operationId;
  if (request.type === 'query') {
    if (reply.type !== 'query-result' || reply.result.kind !== request.query.kind) return false;
    if (request.query.kind !== 'playback.prepare') return true;
    if (reply.result.kind !== 'playback.prepare') return false;
    const target = reply.result.target;
    return target.type === request.query.title.type && target.id === request.query.title.id;
  }
  if (request.type === 'task')
    return reply.type === 'task-result' && reply.result.kind === request.task.kind;
  if (request.type === 'subscribe')
    return reply.type === 'subscribed' && reply.subscriptionId === request.subscriptionId;
  if (request.type === 'unsubscribe')
    return reply.type === 'unsubscribed' && reply.subscriptionId === request.subscriptionId;
  return reply.type === 'observed';
}
