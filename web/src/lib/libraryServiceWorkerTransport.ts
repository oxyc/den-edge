import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceFailure,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import {
  CONTENT_SERVICE_PROTOCOL,
  isContentServiceServerMessage,
  type ContentServiceClientMessage,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import type { ContentServiceTransport } from './contentServiceClient';

type WorkerClientMessage = LibraryServiceClientMessage | ContentServiceClientMessage;
type WorkerServerMessage = LibraryServiceServerMessage | ContentServiceServerMessage;

/**
 * A DedicatedWorker transport. Failure closes this attempt so the supervisor can start a fresh Worker.
 *
 * Messages are validated once, inside the Worker: LibraryServiceWorkerHost decodes every request it receives and
 * every reply batch before posting it. This side only routes what that host posted.
 */
export class WorkerLibraryServiceTransport {
  readonly #libraryListeners = new Set<(message: LibraryServiceServerMessage) => void>();
  readonly #contentListeners = new Set<(message: ContentServiceServerMessage) => void>();
  #closed = false;

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', this.#message);
    worker.addEventListener('error', this.#error);
    worker.addEventListener('messageerror', this.#messageError);
  }

  send(message: WorkerClientMessage): void {
    if (this.#closed) throw new Error('library service worker is unavailable');
    // A synchronous postMessage failure rejects only this local request. In particular, DataCloneError says
    // nothing about the Worker's health; closing the shared transport here also destroys unrelated content
    // queries and makes the supervisor replay the same bad value into every replacement Worker.
    this.worker.postMessage(message);
  }

  listen(listener: (message: LibraryServiceServerMessage) => void): () => void {
    if (this.#closed) return () => {};
    this.#libraryListeners.add(listener);
    return () => this.#libraryListeners.delete(listener);
  }

  /** The content channel shares this Worker's lifetime but receives only content replies. */
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
    this.#dispose();
  }

  readonly #message = (event: MessageEvent<WorkerServerMessage[]>): void => {
    for (const message of event.data) {
      if (this.#closed) break;
      if (isContentServiceServerMessage(message))
        deliver(this.#contentListeners, message as ContentServiceServerMessage);
      else deliver(this.#libraryListeners, message as LibraryServiceServerMessage);
    }
  };

  readonly #error = (event: ErrorEvent): void => {
    event.preventDefault();
    this.#fail({
      code: 'unavailable',
      message: event.message || 'library service worker failed',
      retryable: true,
    });
  };

  readonly #messageError = (event: MessageEvent<unknown>): void => {
    event.preventDefault();
    this.#fail({
      code: 'unavailable',
      message: 'library service worker could not decode a message',
      retryable: true,
    });
  };

  #fail(error: LibraryServiceFailure): void {
    if (this.#closed) return;
    const libraryListeners = [...this.#libraryListeners];
    const contentListeners = [...this.#contentListeners];
    this.#closed = true;
    this.#dispose();
    const message: LibraryServiceServerMessage = {
      type: 'error',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      error,
    };
    const contentMessage: ContentServiceServerMessage = {
      type: 'content-error',
      protocol: CONTENT_SERVICE_PROTOCOL,
      error: {
        code: 'unavailable',
        message: error.message,
        retryable: error.retryable,
      },
    };
    for (const listener of libraryListeners)
      try {
        listener(message);
      } catch (listenerError) {
        console.error('den: a library transport listener failed', listenerError);
      }
    for (const listener of contentListeners)
      try {
        listener(contentMessage);
      } catch (listenerError) {
        console.error('den: a content transport listener failed', listenerError);
      }
  }

  #dispose(): void {
    this.worker.removeEventListener('message', this.#message);
    this.worker.removeEventListener('error', this.#error);
    this.worker.removeEventListener('messageerror', this.#messageError);
    this.worker.terminate();
    this.#libraryListeners.clear();
    this.#contentListeners.clear();
  }
}

function deliver<T>(listeners: ReadonlySet<(message: T) => void>, message: T): void {
  for (const listener of listeners)
    try {
      listener(message);
    } catch (error) {
      console.error('den: a library transport listener failed', error);
    }
}
