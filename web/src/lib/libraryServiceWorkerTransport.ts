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

type MessageListener = (message: unknown) => void;

/** A DedicatedWorker transport. Worker failure is terminal; choosing an inline authority belongs to bootstrap. */
export class WorkerLibraryServiceTransport {
  readonly #listeners = new Set<MessageListener>();
  #closed = false;

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', this.#message);
    worker.addEventListener('error', this.#error);
    worker.addEventListener('messageerror', this.#messageError);
  }

  send(message: LibraryServiceClientMessage): void {
    if (this.#closed) return;
    const decoded = decodeLibraryServiceClientMessage(message);
    if (!decoded.ok) throw new TypeError(decoded.error.message);
    try {
      this.worker.postMessage(decoded.value);
    } catch (error) {
      this.#fail({
        code: 'unavailable',
        message:
          error instanceof Error ? error.message : 'library service worker rejected a request',
        retryable: true,
      });
      throw error;
    }
  }

  listen(listener: MessageListener): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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

    const messages: LibraryServiceServerMessage[] = [];
    for (const candidate of event.data) {
      const decoded = decodeLibraryServiceServerMessage(candidate);
      if (!decoded.ok) {
        this.#fail(decoded.error);
        return;
      }
      messages.push(decoded.value);
    }
    for (const message of messages) {
      if (this.#closed) break;
      for (const listener of this.#listeners)
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
    const listeners = [...this.#listeners];
    this.#closed = true;
    this.#dispose();
    const message: LibraryServiceServerMessage = {
      type: 'error',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      error,
    };
    for (const listener of listeners)
      try {
        listener(message);
      } catch (listenerError) {
        console.error('den: a library transport listener failed', listenerError);
      }
  }

  #dispose(): void {
    this.worker.removeEventListener('message', this.#message);
    this.worker.removeEventListener('error', this.#error);
    this.worker.removeEventListener('messageerror', this.#messageError);
    this.worker.terminate();
    this.#listeners.clear();
  }
}
