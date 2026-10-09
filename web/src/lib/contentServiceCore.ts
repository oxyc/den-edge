import {
  CONTENT_SERVICE_PROTOCOL,
  type ContentRequest,
  type ContentResult,
  type ContentServiceClientMessage,
  type ContentServiceFailure,
  type ContentServiceServerMessage,
  type ContentServiceStatusValue,
} from './contentServiceProtocol';

export interface ContentServiceAuthority {
  query(request: ContentRequest, signal: AbortSignal): Promise<ContentResult>;
  listen?(listener: (status: ContentServiceStatusValue) => void): () => void;
  close?(): void | Promise<void>;
}

export class ContentServiceFault extends Error {
  constructor(readonly failure: ContentServiceFailure) {
    super(failure.message);
    this.name = 'ContentServiceFault';
  }
}

const errorMessage = (
  error: ContentServiceFailure,
  requestId?: string,
): ContentServiceServerMessage => ({
  type: 'content-error',
  protocol: CONTENT_SERVICE_PROTOCOL,
  ...(requestId ? { requestId } : {}),
  error,
});

function asFailure(error: unknown, aborted: boolean): ContentServiceFailure {
  if (error instanceof ContentServiceFault) return error.failure;
  if (aborted || (error instanceof DOMException && error.name === 'AbortError'))
    return {
      code: 'cancelled',
      message: 'content request was cancelled',
      retryable: false,
    };
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : 'content service query failed',
    retryable: true,
  };
}

/**
 * Concurrent read-only content dispatcher. It deliberately has no library actor lane or revision: provider reads
 * may overlap, while the authority underneath owns their cache, flight coalescing and rate-limit gates.
 */
export class ContentServiceCore {
  readonly #requests = new Map<string, AbortController>();
  readonly #listeners = new Set<(messages: ContentServiceServerMessage[]) => void>();
  readonly #stopAuthority: () => void;
  #closed = false;

  constructor(private readonly authority: ContentServiceAuthority) {
    this.#stopAuthority =
      authority.listen?.((status) =>
        this.#publish([{ type: 'content-status', protocol: CONTENT_SERVICE_PROTOCOL, status }]),
      ) ?? (() => {});
  }

  dispatch(message: ContentServiceClientMessage): Promise<ContentServiceServerMessage[]> {
    if (message.type === 'content-cancel') {
      this.#requests.get(message.targetRequestId)?.abort();
      return Promise.resolve([]);
    }
    return this.#query(message.requestId, message.request);
  }

  listen(listener: (messages: ContentServiceServerMessage[]) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopAuthority();
    for (const controller of this.#requests.values()) controller.abort();
    this.#requests.clear();
    this.#listeners.clear();
    await this.authority.close?.();
  }

  async #query(requestId: string, request: ContentRequest): Promise<ContentServiceServerMessage[]> {
    if (this.#closed)
      return [
        errorMessage(
          { code: 'cancelled', message: 'content service is closed', retryable: false },
          requestId,
        ),
      ];
    if (this.#requests.has(requestId))
      return [
        errorMessage(
          {
            code: 'invalid-request',
            message: 'content request id is already in use',
            retryable: false,
          },
          requestId,
        ),
      ];
    const controller = new AbortController();
    this.#requests.set(requestId, controller);
    try {
      const result = await this.authority.query(request, controller.signal);
      if (result.kind !== request.kind)
        throw new ContentServiceFault({
          code: 'internal',
          message: `content service returned ${result.kind} for ${request.kind}`,
          retryable: true,
        });
      if (controller.signal.aborted)
        return [
          errorMessage(
            { code: 'cancelled', message: 'content request was cancelled', retryable: false },
            requestId,
          ),
        ];
      return [{ type: 'content-result', protocol: CONTENT_SERVICE_PROTOCOL, requestId, result }];
    } catch (error) {
      return [errorMessage(asFailure(error, controller.signal.aborted), requestId)];
    } finally {
      if (this.#requests.get(requestId) === controller) this.#requests.delete(requestId);
    }
  }

  #publish(messages: ContentServiceServerMessage[]): void {
    if (this.#closed || !messages.length) return;
    for (const listener of this.#listeners)
      try {
        listener(messages);
      } catch (error) {
        console.error('den: a content service listener failed', error);
      }
  }
}
