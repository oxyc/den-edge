// Speculative work — rows ahead of the scroll, their first pages — run one task at a time while the browser is idle,
// so it never competes with what the viewer is waiting on. Slow or metered links skip it: what they need then loads
// as it nears the screen.

import { permitsScreenPreload } from './screens.svelte';

let chain: Promise<void> = Promise.resolve();
/** The longest one task holds up the next: a slow answer must not stall the whole queue behind it. */
const HOLD_MS = 1000;

/** Run `task` once the tasks queued before it are done and the browser is next idle; never on a slow link. */
export function whenIdle(task: () => unknown): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (!permitsScreenPreload(connection)) return;
  chain = chain.then(
    () =>
      new Promise<void>((resolve) => {
        const run = () => {
          setTimeout(resolve, HOLD_MS);
          Promise.resolve()
            .then(task)
            .catch((error: unknown) => console.warn('idle task failed', error))
            .finally(resolve);
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
        else setTimeout(run, 200);
      }),
  );
}
