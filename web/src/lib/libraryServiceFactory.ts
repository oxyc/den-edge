import { LibraryServiceClient } from './libraryServiceClient';
import { LibraryServiceCore, type LibraryAuthorityOpener } from './libraryServiceCore';
import { InlineLibraryServiceTransport } from './libraryServiceInlineTransport';
import { openLibraryServiceAuthority } from './libraryServiceRuntimeAuthority';
import {
  LibraryServiceSupervisor,
  type LibraryServiceSupervisorOptions,
} from './libraryServiceSupervisor';
import { WorkerLibraryServiceTransport } from './libraryServiceWorkerTransport';

export interface LibraryServiceCapability {
  /** Decided by bootstrap before any hello/open request is sent. */
  dedicatedWorker: boolean;
}

export interface LibraryServiceFactoryOptions {
  supervisor?: LibraryServiceSupervisorOptions;
  /** Test/platform seam; production always uses the service's module Worker. */
  createWorker?: () => Worker;
  /** Test/platform seam shared with the Worker entry's production opener. */
  openAuthority?: LibraryAuthorityOpener;
}

const productionWorker = () =>
  new Worker(new URL('./libraryServiceWorker.ts', import.meta.url), { type: 'module' });

/**
 * Create a supervised service whose transport kind is immutable for its lifetime. A failed Worker may be replaced
 * by another Worker, but it is never replaced by an inline authority mid-session.
 */
export function createLibraryService(
  capability: LibraryServiceCapability,
  options: LibraryServiceFactoryOptions = {},
): LibraryServiceSupervisor {
  if (capability.dedicatedWorker) {
    const createWorker = options.createWorker ?? productionWorker;
    return new LibraryServiceSupervisor(
      () => new LibraryServiceClient(new WorkerLibraryServiceTransport(createWorker())),
      options.supervisor,
    );
  }

  const openAuthority = options.openAuthority ?? openLibraryServiceAuthority;
  return new LibraryServiceSupervisor(
    () =>
      new LibraryServiceClient(
        new InlineLibraryServiceTransport(new LibraryServiceCore(openAuthority)),
      ),
    options.supervisor,
  );
}
