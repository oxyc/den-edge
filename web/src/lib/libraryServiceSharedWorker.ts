/// <reference lib="webworker" />
import { LibraryRuntime } from './libraryRuntime';
import { aggregateLibraryLifecycles } from './librarySharedBroker';
import { ContentAuthority, WorkerContentCredentials } from './contentAuthority';
import { ContentServiceCore } from './contentServiceCore';
import { decodeContentServiceClientMessage } from './contentServiceProtocolCodec';
import {
  CONTENT_SERVICE_PROTOCOL,
  isContentServiceClientMessage,
  type ContentServiceClientMessage,
} from './contentServiceProtocol';
import { RelaySession } from './relayFetch';
import { decodeLibraryServiceClientMessage } from './libraryServiceProtocolCodec';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryObservation,
  type LibraryServiceClientMessage,
  type LibraryServiceHello,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import {
  isSharedWorkerHeartbeat,
  isSharedWorkerDisconnect,
  isSharedWorkerPresence,
  LIBRARY_SHARED_WORKER_PROTOCOL,
} from './librarySharedWorkerProtocol';

const IDLE_CLOSE_MS = 5_000;
const entries = new Map<string, SharedEntry>();
let realmKey: string | undefined;
let realmScope: SharedWorkerGlobalScope | undefined;
let activePorts = 0;
const closeEmptyRealm = () => {
  if (realmScope && activePorts === 0 && entries.size === 0) realmScope.close();
};
interface Client {
  id: string;
  port: MessagePort;
  subscriptions: Set<string>;
  lifecycle?: Extract<LibraryObservation, { kind: 'lifecycle' }>;
  lastSeen: number;
  suspended?: boolean;
  content?: ContentServiceCore;
  relay?: RelaySession;
  disconnect: () => void;
}
const entryKey = (hello: LibraryServiceHello) =>
  JSON.stringify([hello.libraryKey, hello.mode, hello.wire]);
const prefix = (client: Client, id: string) => `${client.id}/${id}`;
const unprefix = (id: string) => {
  const slash = id.indexOf('/');
  return slash > 0 ? { clientId: id.slice(0, slash), id: id.slice(slash + 1) } : undefined;
};

class SharedEntry {
  readonly runtime = new LibraryRuntime();
  readonly clients = new Map<string, Client>();
  readonly #stop = this.runtime.library.listen((messages) => this.#publish(messages));
  #ready?: Extract<LibraryServiceServerMessage, { type: 'ready' }>;
  #openFailure?: Extract<LibraryServiceServerMessage, { type: 'error' }>;
  #opening?: Promise<LibraryServiceServerMessage[]>;
  #idle?: ReturnType<typeof setTimeout>;
  constructor(
    readonly key: string,
    private readonly hello: LibraryServiceHello,
  ) {}

  register(client: Client): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.clients.set(client.id, client);
    if (!client.content) {
      const credentials = new WorkerContentCredentials();
      credentials.bind(this.runtime.contentCredentials);
      const relay = new RelaySession();
      const content = new ContentServiceCore(
        new ContentAuthority(credentials, {
          providerFetch: relay.fetch,
          configureGrants: (grants) => relay.configureGrants(grants),
          onGrantEnded: (listener) => relay.onGrantEnded(listener),
        }),
      );
      content.listen((messages) => this.#post(client, messages));
      client.relay = relay;
      client.content = content;
    }
  }

  async attach(client: Client, requestId: string) {
    this.register(client);
    if (this.#ready) {
      client.relay?.membership(this.#ready.relayMembership);
      this.#post(client, [{ ...this.#ready, requestId }]);
      return;
    }
    if (this.#openFailure) {
      this.#post(client, [{ ...this.#openFailure, requestId }]);
      return;
    }
    if (!this.#opening) {
      this.#opening = this.runtime.library
        .dispatch({
          ...this.hello,
          requestId: prefix(client, requestId),
          clientId: `shared:${this.key}`,
        })
        .catch((error): LibraryServiceServerMessage[] => [
          {
            type: 'error',
            protocol: LIBRARY_SERVICE_PROTOCOL,
            requestId: prefix(client, requestId),
            error: {
              code: 'unavailable',
              message: error instanceof Error ? error.message : 'shared library authority failed',
              retryable: true,
            },
          },
        ]);
      const messages = await this.#opening;
      this.#ready = messages.find(
        (message): message is Extract<LibraryServiceServerMessage, { type: 'ready' }> =>
          message.type === 'ready',
      );
      if (this.#ready)
        for (const attached of this.clients.values())
          attached.relay?.membership(this.#ready.relayMembership);
      this.#openFailure = messages.find(
        (message): message is Extract<LibraryServiceServerMessage, { type: 'error' }> =>
          message.type === 'error',
      );
      this.#publish(messages);
      return;
    }
    await this.#opening;
    const ready = this.#ready as
      Extract<LibraryServiceServerMessage, { type: 'ready' }> | undefined;
    const failure = this.#openFailure as
      Extract<LibraryServiceServerMessage, { type: 'error' }> | undefined;
    if (ready) this.#post(client, [{ ...ready, requestId }]);
    else if (failure) this.#post(client, [{ ...failure, requestId }]);
  }

  content(client: Client, message: ContentServiceClientMessage): void {
    void client.content?.dispatch(message).then(
      (messages) => {
        if (messages.length) this.#post(client, messages);
      },
      (error) =>
        this.#post(client, [
          {
            type: 'content-error',
            protocol: CONTENT_SERVICE_PROTOCOL,
            ...(message.type === 'content-query' ? { requestId: message.requestId } : {}),
            error: {
              code: 'unavailable',
              message: error instanceof Error ? error.message : 'shared content service failed',
              retryable: true,
            },
          },
        ]),
    );
  }

  dispatch(client: Client, message: LibraryServiceClientMessage) {
    if (message.type === 'hello') return;
    const transformed = structuredClone(message) as LibraryServiceClientMessage;
    transformed.requestId = prefix(client, message.requestId);
    if (transformed.type === 'subscribe') {
      client.subscriptions.add(transformed.subscriptionId);
      transformed.subscriptionId = prefix(client, transformed.subscriptionId);
    } else if (transformed.type === 'unsubscribe') {
      client.subscriptions.delete(transformed.subscriptionId);
      transformed.subscriptionId = prefix(client, transformed.subscriptionId);
    } else if (transformed.type === 'observe' && transformed.observation.kind === 'lifecycle') {
      client.lifecycle = transformed.observation;
      transformed.observation = this.#aggregateLifecycle();
    }
    void this.runtime.library.dispatch(transformed).then(
      (messages) => this.#publish(messages),
      (error) =>
        this.#publish([
          {
            type: 'error',
            protocol: LIBRARY_SERVICE_PROTOCOL,
            requestId: transformed.requestId,
            error: {
              code: 'unavailable',
              message: error instanceof Error ? error.message : 'shared library service failed',
              retryable: true,
            },
          },
        ]),
    );
  }

  detach(client: Client) {
    if (!this.clients.delete(client.id)) return;
    void client.content?.close();
    for (const subscriptionId of client.subscriptions)
      void this.runtime.library.dispatch({
        type: 'unsubscribe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: `detached-${crypto.randomUUID()}`,
        subscriptionId: prefix(client, subscriptionId),
      });
    if (client.lifecycle)
      void this.runtime.library.dispatch({
        type: 'observe',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: `detached-${crypto.randomUUID()}`,
        observation: this.#aggregateLifecycle(),
      });
    if (!this.clients.size) {
      const retire = () => {
        if (this.clients.size) return;
        entries.delete(this.key);
        this.#stop();
        void this.runtime.close();
        closeEmptyRealm();
      };
      if (this.#openFailure) retire();
      else this.#idle = setTimeout(retire, IDLE_CLOSE_MS);
    }
  }

  suspend(client: Client): void {
    client.suspended = true;
    client.lifecycle = undefined;
    void this.runtime.library.dispatch({
      type: 'observe',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: `suspended-${crypto.randomUUID()}`,
      observation: this.#aggregateLifecycle(),
    });
  }

  #aggregateLifecycle(): Extract<LibraryObservation, { kind: 'lifecycle' }> {
    const states = [...this.clients.values()].flatMap((client) =>
      !client.suspended && client.lifecycle ? [client.lifecycle] : [],
    );
    return aggregateLibraryLifecycles(states);
  }

  #publish(messages: LibraryServiceServerMessage[]) {
    for (const message of messages) {
      if (
        message.type === 'status' &&
        (message.status.kind === 'moved' || message.status.kind === 'failed')
      )
        for (const client of this.clients.values()) client.relay?.membership(null);
      const request =
        'requestId' in message && message.requestId ? unprefix(message.requestId) : undefined;
      const subscription =
        'subscriptionId' in message && message.subscriptionId
          ? unprefix(message.subscriptionId)
          : undefined;
      const owner = request?.clientId ?? subscription?.clientId;
      const recipients = owner
        ? [this.clients.get(owner)].filter((client): client is Client => !!client)
        : [...this.clients.values()];
      const outgoing = {
        ...message,
        ...(request ? { requestId: request.id } : {}),
        ...(subscription ? { subscriptionId: subscription.id } : {}),
      };
      for (const client of recipients) this.#post(client, [outgoing]);
    }
  }

  #post(client: Client, message: unknown): void {
    try {
      client.port.postMessage(message);
    } catch {
      client.disconnect();
    }
  }
}

/** Install the multiplexing host in a SharedWorker realm. Kept side-effect free so TV builds erase it. */
export function installSharedLibraryServiceWorker(scope: SharedWorkerGlobalScope): void {
  realmScope = scope;
  scope.addEventListener('connect', (event: MessageEvent) => {
    const port = event.ports[0];
    if (!port) return;
    activePorts++;
    let released = false;
    const releasePort = () => {
      if (released) return;
      released = true;
      activePorts--;
      closeEmptyRealm();
    };
    const client: Client = {
      id: crypto.randomUUID(),
      port,
      subscriptions: new Set(),
      lastSeen: Date.now(),
      disconnect: () => {},
    };
    let entry: SharedEntry | undefined;
    const disconnect = () => {
      clearInterval(lease);
      entry?.detach(client);
      port.removeEventListener('message', receive);
      port.close();
      releasePort();
    };
    client.disconnect = disconnect;
    const pendingContent: ContentServiceClientMessage[] = [];
    const receive = (event: MessageEvent<unknown>) => {
      client.lastSeen = Date.now();
      if (isSharedWorkerDisconnect(event.data)) {
        disconnect();
        return;
      }
      if (isSharedWorkerHeartbeat(event.data)) {
        port.postMessage({
          type: 'den-library-heartbeat-ack',
          protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
        });
        return;
      }
      if (isSharedWorkerPresence(event.data)) {
        if (event.data.type === 'den-library-suspend') entry?.suspend(client);
        else client.suspended = false;
        return;
      }
      if (isContentServiceClientMessage(event.data)) {
        const decoded = decodeContentServiceClientMessage(event.data);
        if (!decoded.ok) {
          const requestId =
            typeof (event.data as { requestId?: unknown })?.requestId === 'string'
              ? (event.data as { requestId: string }).requestId
              : undefined;
          port.postMessage([
            {
              type: 'content-error',
              protocol: CONTENT_SERVICE_PROTOCOL,
              ...(requestId ? { requestId } : {}),
              error: decoded.error,
            },
          ]);
        } else if (entry && client.content) entry.content(client, decoded.value);
        else {
          if (pendingContent.length >= 128) {
            port.postMessage([
              {
                type: 'content-error',
                protocol: CONTENT_SERVICE_PROTOCOL,
                ...(decoded.value.type === 'content-query'
                  ? { requestId: decoded.value.requestId }
                  : {}),
                error: {
                  code: 'unavailable',
                  message: 'shared library content queue is full',
                  retryable: true,
                },
              },
            ]);
          } else pendingContent.push(decoded.value);
        }
        return;
      }
      const decoded = decodeLibraryServiceClientMessage(event.data);
      if (!decoded.ok) {
        const requestId =
          typeof (event.data as { requestId?: unknown })?.requestId === 'string'
            ? (event.data as { requestId: string }).requestId
            : undefined;
        port.postMessage([
          {
            type: 'error',
            protocol: LIBRARY_SERVICE_PROTOCOL,
            ...(requestId ? { requestId } : {}),
            error: decoded.error,
          },
        ]);
        return;
      }
      if (!entry) {
        if (decoded.value.type !== 'hello') {
          port.postMessage([
            {
              type: 'error',
              protocol: LIBRARY_SERVICE_PROTOCOL,
              requestId: decoded.value.requestId,
              error: {
                code: 'not-ready',
                message: 'shared library service requires hello',
                retryable: true,
              },
            },
          ]);
          return;
        }
        const key = entryKey(decoded.value);
        if (realmKey !== undefined && realmKey !== key) {
          port.postMessage([
            {
              type: 'error',
              protocol: LIBRARY_SERVICE_PROTOCOL,
              requestId: decoded.value.requestId,
              error: {
                code: 'conflict',
                message: 'SharedWorker belongs to another library identity',
                retryable: false,
              },
            },
          ]);
          return;
        }
        realmKey ??= key;
        entry = entries.get(key);
        if (!entry) {
          entry = new SharedEntry(key, decoded.value);
          entries.set(key, entry);
        }
        entry.register(client);
        void entry.attach(client, decoded.value.requestId).then(() => {
          for (const message of pendingContent.splice(0)) entry?.content(client, message);
        });
        return;
      }
      entry.dispatch(client, decoded.value);
    };
    port.addEventListener('message', receive);
    port.start();
    const lease = setInterval(() => {
      if (client.suspended) return;
      if (Date.now() - client.lastSeen <= 30 * 60_000) return;
      disconnect();
    }, 60_000);
    try {
      port.postMessage({ type: 'den-library-connected', protocol: LIBRARY_SHARED_WORKER_PROTOCOL });
    } catch {
      disconnect();
    }
  });
}
