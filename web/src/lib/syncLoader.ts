import { initializeStartup } from '../vendor/den-core/startup.js';
import { initializeDeferred } from '../vendor/den-core/deferred.js';
import { startupMarkOnce } from './startupTiming';
import { SYNC_POLICY_REQUEST } from './syncPolicyProtocol';

interface PolicyState {
  ready: boolean;
  pending?: Promise<void>;
  startPending?: () => void;
  /** The page's compiled module, or null once it says the Worker must load its own. */
  offered?: Promise<WebAssembly.Module | null>;
  requestOffered?: () => void;
}

const startup: PolicyState = { ready: false };
const deferred: PolicyState = { ready: false };

function acceptOffer(state: PolicyState, port: MessagePort): void {
  state.offered = new Promise((resolve) => {
    port.onmessage = (event: MessageEvent<unknown>) => {
      port.close();
      resolve(event.data instanceof WebAssembly.Module ? event.data : null);
    };
  });
  state.requestOffered = () => {
    state.requestOffered = undefined;
    port.postMessage(SYNC_POLICY_REQUEST);
  };
}

/** A library Worker takes both lifecycle modules from the page's shared compiles, each only if it is requested. */
export function acceptSyncPolicy(startupPort: MessagePort, deferredPort: MessagePort): void {
  acceptOffer(startup, startupPort);
  acceptOffer(deferred, deferredPort);
}

function ensurePolicy(
  state: PolicyState,
  initialize: (input?: WebAssembly.Module) => Promise<void>,
  label: string,
  idle: boolean,
): Promise<void> {
  if (state.ready) return Promise.resolve();
  if (state.pending) {
    if (!idle) state.startPending?.();
    return state.pending;
  }
  state.pending = new Promise<void>((resolve, reject) => {
    let cancel: (() => void) | undefined;
    const start = () => {
      cancel?.();
      state.startPending = undefined;
      state.requestOffered?.();
      startupMarkOnce(`${label} requested`);
      void Promise.resolve()
        .then(async () => initialize((await state.offered) ?? undefined))
        .then(
          () => {
            startupMarkOnce(`${label} ready`);
            state.ready = true;
            resolve();
          },
          (error) => {
            state.pending = undefined;
            reject(error);
          },
        );
    };
    state.startPending = start;
    if (!idle) start();
    else if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(start, { timeout: 2000 });
      cancel = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(start, 200);
      cancel = () => clearTimeout(id);
    }
  });
  return state.pending;
}

/** Opening, importing and browsing policy. */
export function ensureSyncPolicy(idle = false): Promise<void> {
  return ensurePolicy(startup, initializeStartup, 'den-core', idle);
}

/** Mutations, delivery, maintenance and administration, loaded only when that work begins. */
export function ensureDeferredSyncPolicy(idle = false): Promise<void> {
  return ensurePolicy(deferred, initializeDeferred, 'den-core deferred', idle);
}

export function preloadSyncPolicy(): void {
  // Background failures are retried by the next read; only that action reports an opening failure.
  void ensureSyncPolicy(true).catch(() => {});
}
