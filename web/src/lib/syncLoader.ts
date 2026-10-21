import { initialize } from '../vendor/den-core/index.js';
import { SYNC_POLICY_REQUEST } from './syncPolicyModule';

let ready = false;
let pending: Promise<void> | undefined;
let startPending: (() => void) | undefined;
/** The page's compiled den-core, when it offered one (`offerSyncPolicy`); null once it said it has none. */
let offered: Promise<WebAssembly.Module | null> | undefined;
let requestOffered: (() => void) | undefined;

/** A library Worker takes the module the page compiled instead of downloading and compiling its own. */
export function acceptSyncPolicy(port: MessagePort): void {
  offered = new Promise((resolve) => {
    port.onmessage = (event: MessageEvent<unknown>) => {
      port.close();
      resolve(event.data instanceof WebAssembly.Module ? event.data : null);
    };
  });
  requestOffered = () => {
    requestOffered = undefined;
    port.postMessage(SYNC_POLICY_REQUEST);
  };
}

/** One idle warm-up, promoted immediately when an action needs it. Rejections permit a fresh retry. */
export function ensureSyncPolicy(idle = false): Promise<void> {
  if (ready) return Promise.resolve();
  if (pending) {
    if (!idle) startPending?.();
    return pending;
  }
  pending = new Promise<void>((resolve, reject) => {
    let cancel: (() => void) | undefined;
    const start = () => {
      cancel?.();
      startPending = undefined;
      requestOffered?.();
      void Promise.resolve()
        .then(async () => initialize((await offered) ?? undefined))
        .then(
          () => {
            ready = true;
            resolve();
          },
          (error) => {
            pending = undefined;
            reject(error);
          },
        );
    };
    startPending = start;
    if (!idle) start();
    else if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(start, { timeout: 2000 });
      cancel = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(start, 200);
      cancel = () => clearTimeout(id);
    }
  });
  return pending;
}

export function preloadSyncPolicy(): void {
  // Background failures are retried by the next read/action; only that action reports a save failure.
  void ensureSyncPolicy(true).catch(() => {});
}
