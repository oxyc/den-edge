import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceFailure,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import {
  decodeLibraryServiceClientMessage,
  decodeLibraryServiceServerMessage,
} from './libraryServiceProtocolCodec';

interface LibraryServiceDispatcher {
  dispatch(input: unknown): Promise<LibraryServiceServerMessage[]>;
  listen(listener: (messages: LibraryServiceServerMessage[]) => void): () => void;
  close(): void | Promise<void>;
}

interface WorkerHostScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: LibraryServiceServerMessage[]): void;
}

function requestIdOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const requestId = (input as Record<string, unknown>).requestId;
  return typeof requestId === 'string' && requestId.length ? requestId : undefined;
}

function errorMessage(
  error: LibraryServiceFailure,
  requestId?: string,
): LibraryServiceServerMessage {
  return {
    type: 'error',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    ...(requestId ? { requestId } : {}),
    error,
  };
}

/**
 * Owns the transport edge inside a DedicatedWorker. The dispatcher remains transport-independent and is supplied by
 * the worker entry point that knows how to construct the one library authority.
 */
export class LibraryServiceWorkerHost {
  #requests: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #stopListening: () => void;

  constructor(
    private readonly scope: WorkerHostScope,
    private readonly dispatcher: LibraryServiceDispatcher,
  ) {
    scope.addEventListener('message', this.#receive);
    this.#stopListening = dispatcher.listen((messages) => this.#publish(messages));
  }

  readonly #receive = (event: MessageEvent<unknown>): void => {
    if (this.#closed) return;
    const input = event.data;
    this.#requests = this.#requests.then(async () => {
      if (this.#closed) return;
      try {
        const request = decodeLibraryServiceClientMessage(input);
        if (!request.ok) {
          this.#post([errorMessage(request.error, requestIdOf(input))]);
          return;
        }

        this.#publish(await this.dispatcher.dispatch(request.value), request.value.requestId);
      } catch (error) {
        this.#post([
          errorMessage(
            {
              code: 'internal',
              message: error instanceof Error ? error.message : 'library service dispatch failed',
              retryable: true,
            },
            requestIdOf(input),
          ),
        ]);
      }
    });
  };

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.scope.removeEventListener('message', this.#receive);
    this.#stopListening();
    await this.#requests;
    await this.dispatcher.close();
  }

  #publish(output: LibraryServiceServerMessage[], requestId?: string): void {
    const messages: LibraryServiceServerMessage[] = [];
    for (const candidate of output) {
      const decoded = decodeLibraryServiceServerMessage(candidate);
      if (!decoded.ok) {
        this.#post([
          errorMessage(
            {
              code: 'internal',
              message: `library service produced an invalid reply: ${decoded.error.message}`,
              retryable: true,
            },
            requestId,
          ),
        ]);
        return;
      }
      messages.push(decoded.value);
    }
    this.#post(messages);
  }

  #post(messages: LibraryServiceServerMessage[]): void {
    if (!this.#closed && messages.length) this.scope.postMessage(messages);
  }
}
