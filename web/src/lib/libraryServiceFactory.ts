import { LibraryServiceClient } from './libraryServiceClient';
import {
  ContentServiceClient,
  ContentServiceError,
  type ContentServiceClientPort,
} from './contentServiceClient';
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
  onLibraryOpening?: (opening: Promise<unknown>) => void,
): WorkerServiceConnection {
  const transport = new WorkerLibraryServiceTransport(createWorker());
  const content = new ContentServiceClient(transport.contentTransport(), undefined, false);
  const library = new LibraryServiceClient(
    transport,
    undefined,
    startupTimeoutMs,
    (membership) => (membership ? useLibraryRelayMembership(membership) : undefined),
    false,
    onLibraryOpening,
  );
  let closed = false;
  return {
    content,
    library,
    close() {
      if (closed) return;
      closed = true;
      // The connection owns the physical Worker. Closing either logical channel must not tear down its sibling.
      content.close();
      library.close();
      transport.close();
    },
  };
}

/** Stable content facade whose current client follows the library supervisor's replacement Worker. */
class SessionContentService implements ContentServiceClientPort {
  readonly #listeners = new Set<(status: ContentServiceStatusValue) => void>();
  #stopStatus: () => void = () => {};
  #atlas: string | null | undefined;
  #configuredClient?: ContentServiceClient;
  #configuring?: Promise<void>;
  #bootstrap?: Promise<void>;
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
    if (this.#bootstrap) await this.#waitForBootstrap(signal);
    if (request.kind === 'sources.configure') {
      this.#atlas = request.atlas;
      this.#configuredClient = undefined;
      this.#configuring = undefined;
    }
    const client = this.current();
    const requiresAtlas = request.kind.startsWith('atlas.');
    try {
      if (this.#atlas !== undefined || requiresAtlas)
        await this.#ensureConfiguration(client, requiresAtlas);
      if (request.kind === 'sources.configure')
        return { kind: 'sources.configure' } as ContentResultFor<Request>;
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
      if (this.#atlas !== undefined || requiresAtlas)
        await this.#ensureConfiguration(replacement, requiresAtlas);
      if (request.kind === 'sources.configure')
        return { kind: 'sources.configure' } as ContentResultFor<Request>;
      return replacement.query(request, signal);
    }
  }

  onStatus(listener: (status: ContentServiceStatusValue) => void): () => void {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replaced(client: ContentServiceClient): void {
    if (!this.#closed) {
      this.#configuredClient = undefined;
      this.#configuring = undefined;
      this.#bind(client);
    }
  }

  bootstrap(opening: Promise<unknown>): void {
    const barrier = opening.then(
      () => undefined,
      (error: unknown) => {
        throw new ContentServiceError({
          code: 'unavailable',
          message: error instanceof Error ? error.message : 'library bootstrap failed',
          retryable: true,
        });
      },
    );
    this.#bootstrap = barrier;
    void barrier.catch(() => undefined);
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

  async #ensureConfiguration(client: ContentServiceClient, required: boolean): Promise<void> {
    if (this.#atlas === undefined) {
      if (required)
        throw new ContentServiceError({
          code: 'not-ready',
          message: 'content sources have not been resolved',
          retryable: true,
          provider: 'atlas',
        });
      return;
    }
    if (this.#configuredClient === client) return;
    if (!this.#configuring) {
      const work = client.query({ kind: 'sources.configure', atlas: this.#atlas }).then(() => {
        if (this.current() === client) this.#configuredClient = client;
      });
      const settled = work.finally(() => {
        if (this.#configuring === settled) this.#configuring = undefined;
      });
      this.#configuring = settled;
    }
    await this.#configuring;
  }

  async #waitForBootstrap(signal?: AbortSignal): Promise<void> {
    if (!this.#bootstrap) return;
    if (signal?.aborted)
      throw new ContentServiceError({
        code: 'cancelled',
        message: 'content request was cancelled',
        retryable: false,
      });
    await this.#bootstrap;
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
  const contentFacade: { current?: SessionContentService } = {};
  const connection = () =>
    createWorkerServiceConnection(createWorker, options.startupTimeoutMs, (opening) =>
      contentFacade.current?.bootstrap(opening),
    );
  let active = {
    connection: connection(),
    libraryClaimed: false,
  };

  const activate = (libraryClaimed: boolean) => {
    if (closed) throw new Error('Worker service session is closed');
    const previous = active.connection;
    active = {
      connection: connection(),
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
  contentFacade.current = content;

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
