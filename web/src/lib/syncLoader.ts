import { initialize } from '../vendor/den-core/index.js';

let ready = false;
let pending: Promise<void> | undefined;
let startPending: (() => void) | undefined;

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
      void Promise.resolve()
        .then(() => initialize())
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
