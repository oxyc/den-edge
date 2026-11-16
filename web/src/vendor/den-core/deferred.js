import init, { evaluate_deferred as rustEvaluate } from './generated/den_core_deferred.js';

let initialized = false;
let pending;

const safeRuntimeUrl = (url) => {
  const parsed = url instanceof URL ? url : new URL(url, location.href);
  return `${parsed.origin}${parsed.pathname}`;
};

/** Failure-only, allowlisted evidence for the intermittent WebKit CORS report; never includes request headers. */
function reportDeferredWasmFailure(wasm, response, error) {
  const header = (name) => response?.headers.get(name) ?? undefined;
  console.warn(
    `den: deferred-wasm-diagnostic ${JSON.stringify({
      requestInitiator: 'worker-fallback',
      pageOrigin: location.origin,
      workerUrl: safeRuntimeUrl(location.href),
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
}

export function initializeDeferred(input) {
  if (initialized) return Promise.resolve();
  if (!pending) {
    const wasm = new URL('./generated/den_core_deferred_bg.wasm', import.meta.url);
    let response;
    const fallback = input === undefined;
    const source =
      input ??
      fetch(wasm, { signal: AbortSignal.timeout(15000) }).then((value) => {
        response = value;
        return value;
      });
    pending = init({ module_or_path: source })
      .then(() => {
        initialized = true;
      })
      .catch((error) => {
        pending = undefined;
        if (fallback) reportDeferredWasmFailure(wasm, response, error);
        throw error;
      });
  }
  return pending;
}

export function evaluateDeferred(request) {
  if (!initialized) throw new Error('Deferred core is not initialized');
  return rustEvaluate(request);
}
