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
  #closed = false;

  constructor(private readonly core: LibraryServiceCore) {}

  send(message: LibraryServiceClientMessage): void {
    if (this.#closed) return;
    const request = structuredClone(message);
    queueMicrotask(() => {
      if (this.#closed) return;
      void this.core.dispatch(request).then((messages) => {
        if (this.#closed) return;
        for (const reply of messages) {
          const delivered = structuredClone(reply);
          for (const listener of this.#listeners) listener(delivered);
        }
      });
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
    this.#listeners.clear();
    void this.core.close();
  }
}
