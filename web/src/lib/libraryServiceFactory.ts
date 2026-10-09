import { LibraryServiceClient } from './libraryServiceClient';
import { ContentServiceClient, ContentServiceError } from './contentServiceClient';
import type {
  ContentRequest,
  ContentResultFor,
  ContentServiceStatusValue,
} from './contentServiceProtocol';
import {
  LibraryServiceSupervisor,
  type LibraryServiceSupervisorOptions,
} from './libraryServiceSupervisor';
import { WorkerLibraryServiceTransport } from './libraryServiceWorkerTransport';
import { useLibraryRelayMembership } from './relayFetch';

export interface LibraryServiceFactoryOptions {
  supervisor?: LibraryServiceSupervisorOptions;
  /** Test/platform seam; production always uses the service's module Worker. */
  createWorker?: () => Worker;
  /** Test seam for the bounded hello; production waits long enough for the storage-specific deadline to answer. */
  startupTimeoutMs?: number;
}

const productionWorker = () =>
  new Worker(new URL('./libraryServiceWorker.ts', import.meta.url), { type: 'module' });

export interface WorkerServiceConnection {
  /** Available immediately, including for a public visitor who never opens encrypted library state. */
  content: ContentServiceClient;
  /** Open only when this browser has a local or paired library key. */
  library: LibraryServiceClient;
  close(): void;
}

export interface ContentServiceClientPort {
  query<Request extends ContentRequest>(
    request: Request,
    signal?: AbortSignal,
  ): Promise<ContentResultFor<Request>>;
  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void;
}

export interface WorkerServiceSession {
  /** Stable across replacement Workers and usable without opening `library`. */
  content: ContentServiceClientPort;
  /** The optional encrypted-library side of the same current Worker. */
  library: LibraryServiceSupervisor;
  close(): void;
}

/**
 * One Worker and one multiplexed transport for public content plus optional encrypted library state. Keeping this
 * constructor separate from `createLibraryService` lets the staged cutover retain its supervisor unchanged; the
 * final session factory will supervise this whole connection rather than create a second content Worker.
 */
export function createWorkerServiceConnection(
  createWorker: () => Worker = productionWorker,
  startupTimeoutMs?: number,
): WorkerServiceConnection {
  const transport = new WorkerLibraryServiceTransport(createWorker());
  const content = new ContentServiceClient(transport.contentTransport());
  const library = new LibraryServiceClient(transport, undefined, startupTimeoutMs, (membership) =>
    membership ? useLibraryRelayMembership(membership) : undefined,
  );
  let closed = false;
  return {
    content,
    library,
    close() {
      if (closed) return;
      closed = true;
      // Both clients share the idempotent transport close. Reject each client's own pending requests.
      content.close();
      library.close();
    },
  };
}

/** Stable content facade whose current client follows the library supervisor's replacement Worker. */
class SessionContentService implements ContentServiceClientPort {
  readonly #listeners = new Set<(status: ContentServiceStatusValue) => void>();
  #stopStatus: () => void = () => {};
  #closed = false;

  constructor(
    private readonly current: () => ContentServiceClient,
    private readonly replace: (expected: ContentServiceClient) => ContentServiceClient,
  ) {
    this.#bind(current());
  }

  async query<Request extends ContentRequest>(
    request: Request,
    signal?: AbortSignal,
  ): Promise<ContentResultFor<Request>> {
    if (this.#closed)
      throw new ContentServiceError({
        code: 'cancelled',
        message: 'Worker service session is closed',
        retryable: false,
      });
    const client = this.current();
    try {
      return await client.query(request, signal);
    } catch (error) {
      if (
        signal?.aborted ||
        !(error instanceof ContentServiceError) ||
        error.failure.code !== 'unavailable' ||
        error.failure.provider !== undefined ||
        !error.failure.retryable ||
        this.#closed
      )
        throw error;
      const replacement = this.replace(client);
      this.#bind(replacement);
      return replacement.query(request, signal);
    }
  }

  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replaced(client: ContentServiceClient): void {
    if (!this.#closed) this.#bind(client);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopStatus();
    this.#listeners.clear();
  }

  #bind(client: ContentServiceClient): void {
    this.#stopStatus();
    this.#stopStatus = client.onStatus((status) => {
      for (const listener of this.#listeners)
        try {
          listener(status);
        } catch (error) {
          console.error('den: a session content status listener failed', error);
        }
    });
  }
}

/**
 * Session-level owner used by RoutedLibrary. Construction starts one Worker for public content. Opening the library
 * claims that same connection; a supervised library restart replaces the shared connection for both clients.
 */
export function createWorkerServiceSession(
  options: LibraryServiceFactoryOptions = {},
): WorkerServiceSession {
  const createWorker = options.createWorker ?? productionWorker;
  let closed = false;
  let active = {
    connection: createWorkerServiceConnection(createWorker, options.startupTimeoutMs),
    libraryClaimed: false,
  };

  const activate = (libraryClaimed: boolean) => {
    if (closed) throw new Error('Worker service session is closed');
    const previous = active.connection;
    active = {
      connection: createWorkerServiceConnection(createWorker, options.startupTimeoutMs),
      libraryClaimed,
    };
    content.replaced(active.connection.content);
    previous.close();
    return active.connection;
  };
  const content = new SessionContentService(
    () => active.connection.content,
    (expected) =>
      active.connection.content === expected ? activate(false).content : active.connection.content,
  );

  const library = new LibraryServiceSupervisor(() => {
    if (closed) throw new Error('Worker service session is closed');
    if (active.libraryClaimed) return activate(true).library;
    active.libraryClaimed = true;
    content.replaced(active.connection.content);
    return active.connection.library;
  }, options.supervisor);

  return {
    content,
    library,
    close() {
      if (closed) return;
      closed = true;
      content.close();
      library.close();
      active.connection.close();
    },
  };
}

/**
 * Create the supervised DedicatedWorker service. Construction and runtime failures stay visible through the
 * supervisor's normal unavailable/retry surface; the page never takes ownership of the library authority.
 */
export function createLibraryService(
  options: LibraryServiceFactoryOptions = {},
): LibraryServiceSupervisor {
  const createWorker = options.createWorker ?? productionWorker;
  return new LibraryServiceSupervisor(
    () =>
      new LibraryServiceClient(
        new WorkerLibraryServiceTransport(createWorker()),
        undefined,
        options.startupTimeoutMs,
        (membership) => (membership ? useLibraryRelayMembership(membership) : undefined),
      ),
    options.supervisor,
  );
}
