import type { ContentServiceTransport } from './contentServiceClient';
import {
  CONTENT_SERVICE_PROTOCOL,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import type {
  LibraryServiceMultiplexTransport,
  ServiceClientMessage,
} from './libraryServiceMultiplexTransport';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';

let sharedWorkerUsable = true;

/**
 * Loads the platform transport progressively. TV builds fold away the SharedWorker branch, while desktop keeps the
 * relatively large runtime in a separate worker chunk. Messages issued during module/worker startup retain order.
 */
export class AdaptiveLibraryServiceTransport implements LibraryServiceMultiplexTransport {
  readonly #libraryListeners = new Set<(message: LibraryServiceServerMessage) => void>();
  readonly #contentListeners = new Set<(message: ContentServiceServerMessage) => void>();
  readonly #queued: ServiceClientMessage[] = [];
  #backend?: LibraryServiceMultiplexTransport;
  #starting = false;
  #stopLibrary = () => {};
  #stopContent = () => {};
  #closed = false;

  constructor(private readonly dedicated: () => LibraryServiceMultiplexTransport) {}

  send(message: ServiceClientMessage): void {
    if (this.#closed) throw new Error('library service is unavailable');
    if (this.#backend) this.#backend.send(message);
    else {
      this.#queued.push(structuredClone(message));
      if (!this.#starting) {
        const libraryHello = message.type === 'hello';
        const publicContent =
          message.type === 'content-query' &&
          message.request.kind !== 'sources.configure' &&
          message.request.kind !== 'grants.configure';
        if (__DEN_TV__ || publicContent || libraryHello)
          void this.#start(libraryHello && !__DEN_TV__);
        else if (
          message.type === 'content-query' &&
          (message.request.kind === 'sources.configure' ||
            message.request.kind === 'grants.configure')
        )
          queueMicrotask(() => {
            if (!this.#closed && !this.#starting && !this.#backend) void this.#start(false);
          });
      }
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
    this.#closed = true;
    this.#queued.length = 0;
    this.#stopLibrary();
    this.#stopContent();
    this.#backend?.close();
    this.#libraryListeners.clear();
    this.#contentListeners.clear();
  }

  async #start(preferShared: boolean): Promise<void> {
    this.#starting = true;
    let backend: LibraryServiceMultiplexTransport;
    if (
      !__DEN_TV__ &&
      !import.meta.env.DEN_E2E &&
      preferShared &&
      sharedWorkerUsable &&
      typeof SharedWorker !== 'undefined'
    ) {
      try {
        const { SharedWorkerLibraryServiceTransport } =
          await import('./libraryServiceSharedWorkerTransport');
        const shared = new SharedWorkerLibraryServiceTransport();
        backend = shared;
      } catch (error) {
        sharedWorkerUsable = false;
        console.warn(
          'den: SharedWorker library service unavailable; using a dedicated Worker',
          error,
        );
        try {
          backend = this.dedicated();
        } catch (fallbackError) {
          this.#failStartup(fallbackError);
          return;
        }
      }
    } else {
      try {
        backend = this.dedicated();
      } catch (error) {
        this.#failStartup(error);
        return;
      }
    }
    if (this.#closed) {
      backend.close();
      return;
    }
    this.#backend = backend;
    this.#stopLibrary = backend.listen((message) => {
      if (message.type === 'error' && !message.requestId && message.error.code === 'unavailable')
        sharedWorkerUsable = false;
      deliver(this.#libraryListeners, message);
    });
    this.#stopContent = backend
      .contentTransport()
      .listen((message) => deliver(this.#contentListeners, message));
    for (const message of this.#queued.splice(0)) backend.send(message);
  }

  #failStartup(error: unknown): void {
    this.#starting = false;
    const message = error instanceof Error ? error.message : 'library service could not start';
    this.#queued.length = 0;
    deliver(this.#libraryListeners, {
      type: 'error',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      error: { code: 'unavailable', message, retryable: true },
    });
    deliver(this.#contentListeners, {
      type: 'content-error',
      protocol: CONTENT_SERVICE_PROTOCOL,
      error: { code: 'unavailable', message, retryable: true },
    });
  }
}

function deliver<T>(listeners: ReadonlySet<(message: T) => void>, message: T): void {
  for (const listener of listeners)
    try {
      listener(message);
    } catch (error) {
      console.error('den: an adaptive library transport listener failed', error);
    }
}
