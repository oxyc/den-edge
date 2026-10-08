import type {
  LibraryServiceClientMessage,
  LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import { LibraryServiceCore } from './libraryServiceCore';

export type LibraryServiceMessageListener = (message: LibraryServiceServerMessage) => void;

/**
 * The no-Worker transport. Cloning and asynchronous delivery are deliberate: code using it gets the same ownership
 * and scheduling semantics as the eventual Worker transport rather than an accidental synchronous fast path.
 */
export class InlineLibraryServiceTransport {
  readonly #listeners = new Set<LibraryServiceMessageListener>();
  readonly #stopCore: () => void;
  #closed = false;

  constructor(private readonly core: LibraryServiceCore) {
    this.#stopCore = core.listen((messages) => this.#deliver(messages));
  }

  send(message: LibraryServiceClientMessage): void {
    if (this.#closed) throw new Error('library service transport is closed');
    const request = structuredClone(message);
    queueMicrotask(() => {
      if (this.#closed) return;
      void this.core.dispatch(request).then((messages) => this.#deliver(messages));
    });
  }

  listen(listener: LibraryServiceMessageListener): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopCore();
    this.#listeners.clear();
    void this.core.close();
  }

  #deliver(messages: LibraryServiceServerMessage[]): void {
    const batch = structuredClone(messages);
    queueMicrotask(() => {
      if (this.#closed) return;
      for (const reply of batch)
        for (const listener of this.#listeners)
          try {
            listener(structuredClone(reply));
          } catch (error) {
            console.error('den: a library transport listener failed', error);
          }
    });
  }
}
