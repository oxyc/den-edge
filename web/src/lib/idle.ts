// Speculative work — rows ahead of the scroll, their first pages — run one task at a time while the browser is idle,
// so it never competes with what the viewer is waiting on. Slow or metered links skip it: what they need then loads
// as it nears the screen.

import { permitsScreenPreload } from './screens.svelte';

let chain: Promise<void> = Promise.resolve();
/** The longest one task holds up the next: a slow answer must not stall the whole queue behind it. */
const HOLD_MS = 1000;

/**
 * Run `task` once the tasks queued before it are done and the browser is next idle; never on a slow link.
 * The returned cleanup removes work that its component no longer needs before it begins.
 */
export function whenIdle(task: () => unknown): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (!permitsScreenPreload(connection)) return () => {};
  let live = true;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          resolve();
        };
        finish = settle;
        if (!live) {
          settle();
          return;
        }
        const run = () => {
          idle = undefined;
          if (!live) {
            settle();
            return;
          }
          timer = setTimeout(settle, HOLD_MS);
          Promise.resolve()
            .then(task)
            .catch((error: unknown) => console.warn('idle task failed', error))
            .finally(settle);
        };
        if (typeof requestIdleCallback === 'function')
          idle = requestIdleCallback(run, { timeout: 3000 });
        else timer = setTimeout(run, 200);
      }),
  );
  return () => {
    live = false;
    if (idle !== undefined) cancelIdleCallback(idle);
    if (timer !== undefined) clearTimeout(timer);
    finish?.();
  };
}
