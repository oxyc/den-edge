import type { ContentServiceTransport } from './contentServiceClient';
import {
  CONTENT_SERVICE_PROTOCOL,
  isContentServiceServerMessage,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import type {
  LibraryServiceMultiplexTransport,
  ServiceClientMessage,
} from './libraryServiceMultiplexTransport';
import { sharedLibraryIdentity } from './librarySharedBroker';
import {
  isSharedWorkerConnected,
  isSharedWorkerHeartbeatAck,
  LIBRARY_SHARED_WORKER_PROTOCOL,
} from './librarySharedWorkerProtocol';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';

type ServerMessage = LibraryServiceServerMessage | ContentServiceServerMessage;

/** One tab's port into the desktop SharedWorker. The domain protocol remains identical to the in-tab transport. */
export class SharedWorkerLibraryServiceTransport implements LibraryServiceMultiplexTransport {
  readonly ready: Promise<void>;
  #worker?: SharedWorker;
  readonly #queued: ServiceClientMessage[] = [];
  readonly #libraryListeners = new Set<(message: LibraryServiceServerMessage) => void>();
  readonly #contentListeners = new Set<(message: ContentServiceServerMessage) => void>();
  #closed = false;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #startup?: Promise<void>;
  #startupTimer?: ReturnType<typeof setTimeout>;
  #heartbeat?: ReturnType<typeof setInterval>;
  #heartbeatDeadline?: ReturnType<typeof setTimeout>;
  #resumeTimer?: ReturnType<typeof setTimeout>;
  #heartbeatAcks = 0;
  #connected = false;
  #authorityReady = false;
  #lastLifecycle?: ServiceClientMessage;
  readonly #contentConfiguration = new Map<string, ServiceClientMessage>();

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // `ready` is diagnostic; normal callers queue protocol messages and let the LibraryClient startup deadline own
    // recovery. Keep a rejected diagnostic promise from becoming an unhandled rejection.
    void this.ready.catch(() => undefined);
    globalThis.addEventListener?.('pagehide', this.#pageHide as EventListener);
    globalThis.addEventListener?.('pageshow', this.#pageShow as EventListener);
    globalThis.document?.addEventListener('visibilitychange', this.#visibilityChange);
  }

  send(message: ServiceClientMessage): void {
    if (this.#closed) throw new Error('shared library service is unavailable');
    if (message.type === 'observe' && message.observation.kind === 'lifecycle')
      this.#lastLifecycle = structuredClone(message);
    if (
      message.type === 'content-query' &&
      (message.request.kind === 'grants.configure' || message.request.kind === 'sources.configure')
    )
      this.#contentConfiguration.set(message.request.kind, structuredClone(message));
    if (this.#worker) this.#post(message);
    else {
      this.#queued.push(structuredClone(message));
      if (!this.#startup && message.type === 'hello') this.#startup = this.#start(message);
    }
  }

  listen(listener: (message: LibraryServiceServerMessage) => void): () => void {
    if (this.#closed) return () => {};
    this.#libraryListeners.add(listener);
    return () => this.#libraryListeners.delete(listener);
  }

  contentTransport(): ContentServiceTransport {
    return {
      send: (message) => this.send(message),
      listen: (listener) => {
        if (this.#closed) return () => {};
        this.#contentListeners.add(listener);
        return () => this.#contentListeners.delete(listener);
      },
      close: () => this.close(),
    };
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#worker?.port.postMessage({
        type: 'den-library-disconnect',
        protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
      });
    } finally {
      this.#closed = true;
      this.#dispose();
    }
  }

  readonly #message = (event: MessageEvent<ServerMessage[] | unknown>): void => {
    if (isSharedWorkerConnected(event.data)) {
      this.#connected = true;
      this.#resolveReady();
      if (this.#startupTimer) clearTimeout(this.#startupTimer);
      return;
    }
    if (isSharedWorkerHeartbeatAck(event.data)) {
      this.#heartbeatAcks++;
      if (this.#heartbeatDeadline) clearTimeout(this.#heartbeatDeadline);
      this.#heartbeatDeadline = undefined;
      if (this.#resumeTimer) clearTimeout(this.#resumeTimer);
      this.#resumeTimer = undefined;
      return;
    }
    if (!Array.isArray(event.data)) {
      this.#fail('shared library service returned an invalid message');
      return;
    }
    for (const message of event.data) {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('protocol' in message) ||
        (message.protocol !== LIBRARY_SERVICE_PROTOCOL &&
          message.protocol !== CONTENT_SERVICE_PROTOCOL)
      ) {
        this.#fail('shared library service returned an invalid protocol message');
        return;
      }
      if (isContentServiceServerMessage(message)) {
        deliver(this.#contentListeners, message);
      } else {
        const libraryMessage = message as LibraryServiceServerMessage;
        if (libraryMessage.type === 'ready') {
          this.#authorityReady = true;
        } else if (
          libraryMessage.type === 'error' &&
          libraryMessage.error.retryable &&
          !this.#authorityReady
        ) {
          this.#fail(libraryMessage.error.message);
          return;
        }
        deliver(this.#libraryListeners, libraryMessage);
      }
    }
  };

  readonly #error = (event: ErrorEvent): void => {
    event.preventDefault();
    this.#fail(event.message || 'shared library service failed');
  };

  readonly #messageError = (event: MessageEvent<unknown>): void => {
    event.preventDefault();
    this.#fail('shared library service could not decode a message');
  };

  #fail(message: string): void {
    if (this.#closed) return;
    const listeners = [...this.#libraryListeners];
    const contentListeners = [...this.#contentListeners];
    this.#closed = true;
    this.#rejectReady(new Error(message));
    this.#dispose();
    const failure: LibraryServiceServerMessage = {
      type: 'error',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      error: { code: 'unavailable', message, retryable: true },
    };
    for (const listener of listeners) listener(failure);
    for (const listener of contentListeners)
      listener({
        type: 'content-error',
        protocol: CONTENT_SERVICE_PROTOCOL,
        error: { code: 'unavailable', message, retryable: true },
      });
  }

  #dispose(): void {
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#heartbeatDeadline) clearTimeout(this.#heartbeatDeadline);
    if (this.#resumeTimer) clearTimeout(this.#resumeTimer);
    globalThis.removeEventListener?.('pagehide', this.#pageHide as EventListener);
    globalThis.removeEventListener?.('pageshow', this.#pageShow as EventListener);
    globalThis.document?.removeEventListener('visibilitychange', this.#visibilityChange);
    this.#queued.length = 0;
    this.#worker?.port.removeEventListener('message', this.#message);
    this.#worker?.port.removeEventListener('messageerror', this.#messageError);
    this.#worker?.removeEventListener('error', this.#error);
    this.#worker?.port.close();
    this.#libraryListeners.clear();
    this.#contentListeners.clear();
  }

  readonly #pageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      this.close();
      return;
    }
    if (this.#heartbeatDeadline) {
      clearTimeout(this.#heartbeatDeadline);
      this.#heartbeatDeadline = undefined;
    }
    this.#post({
      type: 'den-library-suspend',
      protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
    });
  };

  readonly #pageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || !this.#worker || this.#closed) return;
    this.#post({
      type: 'den-library-resume',
      protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
    });
    for (const message of this.#contentConfiguration.values()) this.#post(message);
    if (this.#lastLifecycle) this.#post(this.#lastLifecycle);
    const before = this.#heartbeatAcks;
    this.#post({
      type: 'den-library-heartbeat',
      protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
    });
    if (this.#resumeTimer) clearTimeout(this.#resumeTimer);
    this.#resumeTimer = setTimeout(() => {
      if (this.#heartbeatAcks === before) this.#fail('shared library service did not resume');
    }, 5_000);
  };

  readonly #visibilityChange = (): void => {
    if (globalThis.document?.visibilityState === 'visible') this.#probeHeartbeat();
    else if (this.#heartbeatDeadline) {
      clearTimeout(this.#heartbeatDeadline);
      this.#heartbeatDeadline = undefined;
    }
  };

  #probeHeartbeat(): void {
    if (!this.#worker || this.#closed || globalThis.document?.visibilityState === 'hidden') return;
    const before = this.#heartbeatAcks;
    this.#post({
      type: 'den-library-heartbeat',
      protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
    });
    if (this.#heartbeatDeadline) clearTimeout(this.#heartbeatDeadline);
    this.#heartbeatDeadline = setTimeout(() => {
      this.#heartbeatDeadline = undefined;
      if (this.#heartbeatAcks === before) this.#fail('shared library service heartbeat timed out');
    }, 10_000);
  }

  #post(message: unknown): void {
    if (!this.#worker || this.#closed) return;
    try {
      this.#worker.port.postMessage(message);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : 'shared library service disconnected');
    }
  }

  async #start(hello: Extract<ServiceClientMessage, { type: 'hello' }>): Promise<void> {
    try {
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        // This lazy transport chunk contains the content-hashed worker URL, so its own URL is a release fence.
        new TextEncoder().encode(sharedLibraryIdentity(import.meta.url, hello)),
      );
      if (this.#closed) return;
      const digest = [...new Uint8Array(bytes)]
        .slice(0, 12)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      const worker = new SharedWorker(new URL('./libraryServiceWorker.ts', import.meta.url), {
        type: 'module',
        // A SharedWorker realm is one library identity. This partitions module globals (relay grants, den-core
        // lifecycle, startup metrics) while tabs on the same library converge on the same canonical runtime.
        name: `den-library-${LIBRARY_SHARED_WORKER_PROTOCOL}-${digest}`,
      });
      this.#worker = worker;
      worker.port.addEventListener('message', this.#message);
      worker.port.addEventListener('messageerror', this.#messageError);
      worker.addEventListener('error', this.#error);
      this.#startupTimer = setTimeout(() => {
        if (!this.#connected) this.#fail('shared library service startup timed out');
      }, 15_000);
      this.#heartbeat = setInterval(() => this.#probeHeartbeat(), 30_000);
      worker.port.start();
      for (const message of this.#queued.splice(0)) this.#post(message);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : 'shared library service could not start');
    }
  }
}

function deliver<T>(listeners: ReadonlySet<(message: T) => void>, message: T): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.error('den: a shared library transport listener failed', error);
    }
  }
}

export const createSharedWorkerLibraryServiceTransport = (): LibraryServiceMultiplexTransport =>
  new SharedWorkerLibraryServiceTransport();
