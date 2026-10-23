import { initialize } from '../vendor/den-core-tizen3/index.js';
import { startupMarkOnce } from './startupTiming';

let ready = false;
let pending: Promise<void> | undefined;
let startPending: (() => void) | undefined;

/** Tizen 3 has no transferable Wasm modules; close stale offers defensively. */
export function acceptSyncPolicy(startup: MessagePort, deferred: MessagePort): void {
  startup.close();
  deferred.close();
}

/** Load the checked-in JavaScript policy once, using the same idle/promotion contract as the Wasm loader. */
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
      startupMarkOnce('den-core requested');
      void initialize().then(
        () => {
          startupMarkOnce('den-core ready');
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
  void ensureSyncPolicy(true).catch(() => {});
}

/** Its generated JavaScript core is monolithic, so either lifecycle capability shares the same initialization. */
export const ensureDeferredSyncPolicy = ensureSyncPolicy;
