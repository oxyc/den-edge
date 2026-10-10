import {
  CONTENT_SERVICE_PROTOCOL,
  isContentServiceServerMessage,
  type ContentRequest,
  type ContentResult,
  type ContentResultFor,
  type ContentServiceClientMessage,
  type ContentServiceFailure,
  type ContentServiceServerMessage,
  type ContentServiceStatusValue,
} from './contentServiceProtocol';
import { decodeContentServiceServerMessage } from './contentServiceProtocolCodec';

export interface ContentServiceTransport {
  send(message: ContentServiceClientMessage): void;
  listen(listener: (message: unknown) => void): () => void;
  close(): void;
}

/** The page's complete semantic content surface, independent of Worker/client implementation details. */
export interface ContentServiceClientPort {
  query<Request extends ContentRequest>(
    request: Request,
    signal?: AbortSignal,
  ): Promise<ContentResultFor<Request>>;
  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void;
}

interface Pending {
  request: ContentRequest;
  resolve: (result: ContentResult) => void;
  reject: (error: ContentServiceError) => void;
  stopAbort?: () => void;
}

export class ContentServiceError extends Error {
  constructor(
    readonly failure: ContentServiceFailure,
    /** Local distinction only: the wire already distinguishes a request reply from a channel-wide failure. */
    readonly scope: 'request' | 'transport' | 'local' = 'request',
  ) {
    super(failure.message);
    this.name = 'ContentServiceError';
  }
}

const cancelled = (): ContentServiceError =>
  new ContentServiceError(
    {
      code: 'cancelled',
      message: 'content request was cancelled',
      retryable: false,
    },
    'local',
  );

/** Typed page facade for read-only content. Provider credentials and library versions never cross this boundary. */
export class ContentServiceClient {
  readonly #pending = new Map<string, Pending>();
  readonly #statusListeners = new Set<(status: ContentServiceStatusValue) => void>();
  readonly #stopListening: () => void;
  #nextRequest = 0;
  #closed = false;

  constructor(
    private readonly transport: ContentServiceTransport,
    private readonly clientId: string = crypto.randomUUID(),
    private readonly ownsTransport = true,
  ) {
    this.#stopListening = transport.listen((message) => this.#receive(message));
  }

  query<Request extends ContentRequest>(
    request: Request,
    signal?: AbortSignal,
  ): Promise<ContentResultFor<Request>> {
    this.#assertOpen();
    if (signal?.aborted) return Promise.reject(cancelled());
    const requestId = `${this.clientId}:content:${++this.#nextRequest}`;
    return new Promise<ContentResultFor<Request>>((resolve, reject) => {
      const pending: Pending = {
        request,
        resolve: (result) => resolve(result as ContentResultFor<Request>),
        reject,
      };
      if (signal) {
        const abort = () => {
          if (this.#pending.get(requestId) !== pending) return;
          this.#pending.delete(requestId);
          pending.stopAbort?.();
          pending.reject(cancelled());
          try {
            this.transport.send({
              type: 'content-cancel',
              protocol: CONTENT_SERVICE_PROTOCOL,
              targetRequestId: requestId,
            });
          } catch {
            // The local waiter is already cancelled; a failed transport has nothing left to reject here.
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.stopAbort = () => signal.removeEventListener('abort', abort);
      }
      this.#pending.set(requestId, pending);
      try {
        this.transport.send({
          type: 'content-query',
          protocol: CONTENT_SERVICE_PROTOCOL,
          requestId,
          request,
        });
      } catch (error) {
        this.#pending.delete(requestId);
        pending.stopAbort?.();
        reject(
          error instanceof ContentServiceError
            ? error
            : new ContentServiceError(
                {
                  code: 'unavailable',
                  message:
                    error instanceof Error ? error.message : 'content service transport failed',
                  retryable: true,
                },
                'transport',
              ),
        );
      }
    });
  }

  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void {
    if (this.#closed) return () => {};
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopListening();
    if (this.ownsTransport) this.transport.close();
    const error = cancelled();
    for (const pending of this.#pending.values()) {
      pending.stopAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
    this.#statusListeners.clear();
  }

  #receive(input: unknown): void {
    if (this.#closed || !isContentServiceServerMessage(input)) return;
    const decoded = decodeContentServiceServerMessage(input);
    if (!decoded.ok) {
      this.#failAll(decoded.error);
      return;
    }
    const message: ContentServiceServerMessage = decoded.value;
    if (message.type === 'content-status') {
      for (const listener of this.#statusListeners)
        try {
          listener(message.status);
        } catch (error) {
          console.error('den: a content status listener failed', error);
        }
      return;
    }
    if (message.type === 'content-error' && !message.requestId) {
      this.#failAll(message.error);
      return;
    }
    const requestId = message.requestId;
    if (!requestId) return;
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    pending.stopAbort?.();
    if (message.type === 'content-error') {
      pending.reject(new ContentServiceError(message.error));
      return;
    }
    if (message.result.kind !== pending.request.kind) {
      pending.reject(
        new ContentServiceError({
          code: 'invalid-request',
          message: `content service returned ${message.result.kind} for ${pending.request.kind}`,
          retryable: false,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(failure: ContentServiceFailure): void {
    const error = new ContentServiceError(failure, 'transport');
    for (const pending of this.#pending.values()) {
      pending.stopAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #assertOpen(): void {
    if (!this.#closed) return;
    throw cancelled();
  }
}
