import { LibraryServiceClient } from './libraryServiceClient';
import {
  LibraryServiceSupervisor,
  type LibraryServiceSupervisorOptions,
} from './libraryServiceSupervisor';
import { WorkerLibraryServiceTransport } from './libraryServiceWorkerTransport';

export interface LibraryServiceFactoryOptions {
  supervisor?: LibraryServiceSupervisorOptions;
  /** Test/platform seam; production always uses the service's module Worker. */
  createWorker?: () => Worker;
  /** Test seam for the bounded hello; production waits long enough for the storage-specific deadline to answer. */
  startupTimeoutMs?: number;
}

const productionWorker = () =>
  new Worker(new URL('./libraryServiceWorker.ts', import.meta.url), { type: 'module' });

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
      ),
    options.supervisor,
  );
}
