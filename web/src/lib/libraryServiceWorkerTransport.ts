import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceFailure,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import {
  decodeLibraryServiceClientMessage,
  decodeLibraryServiceServerMessage,
} from './libraryServiceProtocolCodec';
import {
  CONTENT_SERVICE_PROTOCOL,
  isContentServiceClientMessage,
  isContentServiceServerMessage,
  type ContentServiceClientMessage,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import {
  decodeContentServiceClientMessage,
  decodeContentServiceServerMessage,
} from './contentServiceProtocolCodec';
import type { ContentServiceTransport } from './contentServiceClient';

type MessageListener = (message: unknown) => void;
type WorkerClientMessage = LibraryServiceClientMessage | ContentServiceClientMessage;
type WorkerServerMessage = LibraryServiceServerMessage | ContentServiceServerMessage;

/** A DedicatedWorker transport. Failure closes this attempt so the supervisor can start a fresh Worker. */
export class WorkerLibraryServiceTransport {
  readonly #libraryListeners = new Set<MessageListener>();
  readonly #contentListeners = new Set<MessageListener>();
  #closed = false;

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', this.#message);
    worker.addEventListener('error', this.#error);
    worker.addEventListener('messageerror', this.#messageError);
  }

  send(message: WorkerClientMessage): void {
    if (this.#closed) throw new Error('library service worker is unavailable');
    const decoded = isContentServiceClientMessage(message)
      ? decodeContentServiceClientMessage(message)
      : decodeLibraryServiceClientMessage(message);
    if (!decoded.ok) throw new TypeError(decoded.error.message);
    // A synchronous postMessage failure rejects only this local request. In particular, DataCloneError says
    // nothing about the Worker's health; closing the shared transport here also destroys unrelated content
    // queries and makes the supervisor replay the same bad value into every replacement Worker.
    this.worker.postMessage(decoded.value);
  }

  listen(listener: MessageListener): () => void {
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

  readonly #message = (event: MessageEvent<unknown>): void => {
    if (this.#closed) return;
    if (!Array.isArray(event.data) || event.data.length === 0) {
      this.#fail({
        code: 'invalid-request',
        message: 'library service worker reply must be a non-empty batch',
        retryable: false,
      });
      return;
    }

    const messages: WorkerServerMessage[] = [];
    for (const candidate of event.data) {
      const decoded = isContentServiceServerMessage(candidate)
        ? decodeContentServiceServerMessage(candidate)
        : decodeLibraryServiceServerMessage(candidate);
      if (!decoded.ok) {
        this.#fail({
          code: 'invalid-request',
          message: decoded.error.message,
          retryable: false,
        });
        return;
      }
      messages.push(decoded.value);
    }
    for (const message of messages) {
      if (this.#closed) break;
      const listeners = isContentServiceServerMessage(message)
        ? this.#contentListeners
        : this.#libraryListeners;
      for (const listener of listeners)
        try {
          listener(message);
        } catch (error) {
          console.error('den: a library transport listener failed', error);
        }
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
