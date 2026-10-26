import { LibraryRuntime } from './libraryRuntime';
import { installSharedLibraryServiceWorker } from './libraryServiceSharedWorker';
import { LibraryServiceWorkerHost, type WorkerHostScope } from './libraryServiceWorkerHost';
import { startupMark } from './startupTiming';

// Its modules are loaded and evaluated: from `worker created` to here is the Worker's own boot.
startupMark('script evaluated');

const scope = self as unknown as WorkerHostScope & SharedWorkerGlobalScope;
if (!__DEN_TV__ && 'onconnect' in self) {
  installSharedLibraryServiceWorker(scope);
} else {
  // This Worker owns exactly one Core and therefore at most one live LibraryLog. A replacement Worker gets a fresh
  // authority; the page never hydrates or receives that log.
  const runtime = new LibraryRuntime();
  new LibraryServiceWorkerHost(scope, runtime.library, runtime.content);
}
