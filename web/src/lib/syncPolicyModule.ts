// den-core's policy wasm, downloaded and compiled once for every library Worker this page starts. A profile household
// opens two libraries, one Worker each; each used to fetch the same 1.66 MB wasm and compile it again (WebKit
// downloads both, Chromium shares the transfer but still compiles twice).

/** The first message a library Worker receives: the port its compiled den-core arrives on (`acceptSyncPolicy`). */
export const SYNC_POLICY_OFFER = 'den-core-module';
export const SYNC_POLICY_REQUEST = 'den-core-module-request';

const WASM = new URL('../vendor/den-core/generated/den_core_bg.wasm', import.meta.url);

let compiling: Promise<WebAssembly.Module> | undefined;

/** One compile per page; a failed one is tried again by the next Worker. */
function syncPolicyModule(): Promise<WebAssembly.Module> {
  compiling ??= WebAssembly.compileStreaming(
    fetch(WASM, { signal: AbortSignal.timeout(15_000) }),
  ).catch((error: unknown) => {
    compiling = undefined;
    throw error;
  });
  return compiling;
}

/**
 * Offer `worker` this page's compiled den-core without compiling it yet. The offer is posted before anything else,
 * so the Worker knows to ask here rather than start a download of its own. A cache-first Worker that never needs
 * policy leaves the port idle and neither fetches nor compiles wasm. Once asked, a page that cannot compile it
 * answers null and the Worker loads den-core itself as before.
 */
export function offerSyncPolicy(worker: Worker): void {
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ type: SYNC_POLICY_OFFER, port: port2 }, [port2]);
  port1.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data !== SYNC_POLICY_REQUEST) return;
    port1.onmessage = null;
    void syncPolicyModule().then(
      (module) => {
        port1.postMessage(module);
        port1.close();
      },
      (error: unknown) => {
        console.warn('den: the page could not compile den-core; the Worker loads its own', error);
        port1.postMessage(null);
        port1.close();
      },
    );
  };
}
