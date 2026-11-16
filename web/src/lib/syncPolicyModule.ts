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

const safeRuntimeUrl = (url: URL | string): string => {
  const parsed = url instanceof URL ? url : new URL(url, location.href);
  return `${parsed.origin}${parsed.pathname}`;
};

/** Failure-only, allowlisted evidence for the intermittent WebKit CORS report; never includes request headers. */
const reportDeferredWasmFailure = (
  wasm: URL,
  response: Response | undefined,
  error: unknown,
): void => {
  const header = (name: string) => response?.headers.get(name) ?? undefined;
  console.warn(
    `den: deferred-wasm-diagnostic ${JSON.stringify({
      requestInitiator: 'page-policy-offer',
      pageOrigin: location.origin,
      workerUrl: null,
      wasmUrl: safeRuntimeUrl(wasm),
      response: response
        ? {
            url: safeRuntimeUrl(response.url || wasm),
            status: response.status,
            type: response.type,
            contentType: header('content-type'),
            accessControlAllowOrigin: header('access-control-allow-origin'),
            crossOriginResourcePolicy: header('cross-origin-resource-policy'),
            crossOriginEmbedderPolicy: header('cross-origin-embedder-policy'),
          }
        : null,
      errorName: error instanceof Error ? error.name : typeof error,
    })}`,
  );
};

/** One compile of each lifecycle module per page; a failed one is tried again by the next Worker. */
function syncPolicyModule(kind: PolicyModule): Promise<WebAssembly.Module> {
  const held = compiling[kind];
  if (held) return held;
  const label = kind === 'startup' ? 'den-core' : 'den-core deferred';
  startupMarkOnce(`${label} compile started`);
  const wasm = kind === 'startup' ? STARTUP_WASM : DEFERRED_WASM;
  let response: Response | undefined;
  const request = fetch(wasm, { signal: AbortSignal.timeout(15_000) }).then((value) => {
    response = value;
    return value;
  });
  const started = WebAssembly.compileStreaming(request)
    .then((module) => {
      startupMarkOnce(`${label} compiled`);
      return module;
    })
    .catch((error: unknown) => {
      delete compiling[kind];
      if (kind === 'deferred') reportDeferredWasmFailure(wasm, response, error);
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
