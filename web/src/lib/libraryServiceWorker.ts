import { ContentAuthority, WorkerContentCredentials } from './contentAuthority';
import { ContentServiceCore } from './contentServiceCore';
import { LibraryServiceCore } from './libraryServiceCore';
import { openLibraryServiceAuthority } from './libraryServiceRuntimeAuthority';
import { LibraryServiceWorkerHost, type WorkerHostScope } from './libraryServiceWorkerHost';

// This Worker owns exactly one Core and therefore at most one live LibraryLog. A replacement Worker gets a fresh
// authority; the page never hydrates or receives that log.
const contentCredentials = new WorkerContentCredentials();
const contentAuthority = new ContentAuthority(contentCredentials);
new LibraryServiceWorkerHost(
  self as unknown as WorkerHostScope,
  new LibraryServiceCore((request) =>
    openLibraryServiceAuthority(request, undefined, contentCredentials, contentAuthority),
  ),
  new ContentServiceCore(contentAuthority),
);
