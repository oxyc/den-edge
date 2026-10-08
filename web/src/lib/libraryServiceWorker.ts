import { LibraryServiceCore } from './libraryServiceCore';
import { openLibraryServiceAuthority } from './libraryServiceRuntimeAuthority';
import { LibraryServiceWorkerHost, type WorkerHostScope } from './libraryServiceWorkerHost';

// This Worker owns exactly one Core and therefore at most one live LibraryLog. A replacement Worker gets a fresh
// authority; the page never hydrates or receives that log.
new LibraryServiceWorkerHost(
  self as unknown as WorkerHostScope,
  new LibraryServiceCore(openLibraryServiceAuthority),
);
