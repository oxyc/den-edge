// den-core's lifecycle policy Wasm, downloaded and compiled once for every library Worker this page starts. Startup
// carries opening and browse reads; mutations and background delivery ask for the larger deferred module later.

import { startupMarkOnce } from './startupTiming';
import { SYNC_POLICY_OFFER, SYNC_POLICY_REQUEST } from './syncPolicyProtocol';

const STARTUP_WASM = new URL(
  '../vendor/den-core/generated/den_core_startup_bg.wasm',
  import.meta.url,
);
const DEFERRED_WASM = new URL(
  '../vendor/den-core/generated/den_core_deferred_bg.wasm',
  import.meta.url,
);

type PolicyModule = 'startup' | 'deferred';
const compiling: Partial<Record<PolicyModule, Promise<WebAssembly.Module>>> = {};

/** One compile of each lifecycle module per page; a failed one is tried again by the next Worker. */
function syncPolicyModule(kind: PolicyModule): Promise<WebAssembly.Module> {
  const held = compiling[kind];
  if (held) return held;
  const label = kind === 'startup' ? 'den-core' : 'den-core deferred';
  startupMarkOnce(`${label} compile started`);
  const wasm = kind === 'startup' ? STARTUP_WASM : DEFERRED_WASM;
  const started = WebAssembly.compileStreaming(fetch(wasm, { signal: AbortSignal.timeout(15_000) }))
    .then((module) => {
      startupMarkOnce(`${label} compiled`);
      return module;
    })
    .catch((error: unknown) => {
      delete compiling[kind];
      throw error;
    });
  compiling[kind] = started;
  return started;
}

function answerPolicyOffer(port: MessagePort, kind: PolicyModule): void {
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data !== SYNC_POLICY_REQUEST) return;
    port.onmessage = null;
    void syncPolicyModule(kind).then(
      (module) => {
        port.postMessage(module);
        port.close();
      },
      (error: unknown) => {
        console.warn(
          `den: the page could not compile den-core ${kind}; the Worker loads its own`,
          error,
        );
        port.postMessage(null);
        port.close();
      },
    );
  };
}

/**
 * Offer `worker` this page's compiled den-core without compiling it yet. The offer is posted before anything else,
 * so the Worker knows to ask here rather than start a download of its own. A cache-first Worker that never needs
 * policy leaves the port idle and neither fetches nor compiles wasm. Once asked, a page that cannot compile it
 * answers null and the Worker loads den-core itself as before.
 */
export function offerSyncPolicy(worker: Worker): void {
  const startup = new MessageChannel();
  const deferred = new MessageChannel();
  worker.postMessage(
    { type: SYNC_POLICY_OFFER, startup: startup.port2, deferred: deferred.port2 },
    [startup.port2, deferred.port2],
  );
  answerPolicyOffer(startup.port1, 'startup');
  answerPolicyOffer(deferred.port1, 'deferred');
}
