import { LibraryServiceClient } from './libraryServiceClient';
import { ContentServiceClient } from './contentServiceClient';
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
  const library = new LibraryServiceClient(transport, undefined, startupTimeoutMs);
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
