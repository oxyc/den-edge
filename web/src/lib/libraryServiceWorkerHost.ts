import {
  LIBRARY_SERVICE_PROTOCOL,
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
  type ContentServiceClientMessage,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import {
  decodeContentServiceClientMessage,
  decodeContentServiceServerMessage,
} from './contentServiceProtocolCodec';

interface LibraryServiceDispatcher {
  dispatch(input: unknown): Promise<LibraryServiceServerMessage[]>;
  listen(listener: (messages: LibraryServiceServerMessage[]) => void): () => void;
  close(): void | Promise<void>;
}

interface ContentServiceDispatcher {
  dispatch(input: ContentServiceClientMessage): Promise<ContentServiceServerMessage[]>;
  listen(listener: (messages: ContentServiceServerMessage[]) => void): () => void;
  close(): void | Promise<void>;
}

type WorkerServerMessage = LibraryServiceServerMessage | ContentServiceServerMessage;

export interface WorkerHostScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WorkerServerMessage[]): void;
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
  readonly #work = new Set<Promise<void>>();
  #closed = false;
  readonly #stopListening: Array<() => void>;

  constructor(
    private readonly scope: WorkerHostScope,
    private readonly dispatcher: LibraryServiceDispatcher,
    private readonly content?: ContentServiceDispatcher,
  ) {
    scope.addEventListener('message', this.#receive);
    this.#stopListening = [
      dispatcher.listen((messages) => this.#publishLibrary(messages)),
      ...(content ? [content.listen((messages) => this.#publishContent(messages))] : []),
    ];
  }

  readonly #receive = (event: MessageEvent<unknown>): void => {
    if (this.#closed) return;
    const input = event.data;
    // The dispatcher owns authority ordering. Admit every message to it in event order, but do not hold later
    // messages behind a remote provider promise: Core deliberately lets commands run while metadata is in flight.
    const work = this.#dispatch(input);
    this.#work.add(work);
    void work.finally(() => this.#work.delete(work));
  };

  async #dispatch(input: unknown): Promise<void> {
    if (this.#closed) return;
    if (isContentServiceClientMessage(input)) {
      await this.#dispatchContent(input);
      return;
    }
    try {
      const request = decodeLibraryServiceClientMessage(input);
      if (!request.ok) {
        this.#post([errorMessage(request.error, requestIdOf(input))]);
        return;
      }

      this.#publishLibrary(await this.dispatcher.dispatch(request.value), request.value.requestId);
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
  }

  async #dispatchContent(input: unknown): Promise<void> {
    const request = decodeContentServiceClientMessage(input);
    if (!request.ok) {
      const requestId = requestIdOf(input);
      this.#post([
        {
          type: 'content-error',
          protocol: CONTENT_SERVICE_PROTOCOL,
          ...(requestId ? { requestId } : {}),
          error: request.error,
        },
      ]);
      return;
    }
    if (!this.content) {
      if (request.value.type === 'content-query')
        this.#post([
          {
            type: 'content-error',
            protocol: CONTENT_SERVICE_PROTOCOL,
            requestId: request.value.requestId,
            error: {
              code: 'not-ready',
              message: 'content service is not ready',
              retryable: true,
            },
          },
        ]);
      return;
    }
    try {
      this.#publishContent(
        await this.content.dispatch(request.value),
        request.value.type === 'content-query' ? request.value.requestId : undefined,
      );
    } catch (error) {
      if (request.value.type === 'content-query')
        this.#post([
          {
            type: 'content-error',
            protocol: CONTENT_SERVICE_PROTOCOL,
            requestId: request.value.requestId,
            error: {
              code: 'internal',
              message: error instanceof Error ? error.message : 'content service dispatch failed',
              retryable: true,
            },
          },
        ]);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.scope.removeEventListener('message', this.#receive);
    for (const stop of this.#stopListening) stop();
    // Content reads are independent remote work. Abort them before waiting; a provider that never answers must not
    // prevent this Worker from closing. Library Core retains its own ordered drain below.
    const closingContent = this.content?.close();
    await Promise.allSettled([...this.#work]);
    await Promise.allSettled([this.dispatcher.close(), closingContent]);
  }

  #publishLibrary(output: LibraryServiceServerMessage[], requestId?: string): void {
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

  #publishContent(output: ContentServiceServerMessage[], requestId?: string): void {
    const messages: ContentServiceServerMessage[] = [];
    for (const candidate of output) {
      const decoded = decodeContentServiceServerMessage(candidate);
      if (!decoded.ok) {
        this.#post([
          {
            type: 'content-error',
            protocol: CONTENT_SERVICE_PROTOCOL,
            ...(requestId ? { requestId } : {}),
            error: {
              code: 'internal',
              message: `content service produced an invalid reply: ${decoded.error.message}`,
              retryable: true,
            },
          },
        ]);
        return;
      }
      messages.push(decoded.value);
    }
    this.#post(messages);
  }

  #post(messages: WorkerServerMessage[]): void {
    if (!this.#closed && messages.length) this.scope.postMessage(messages);
  }
}
