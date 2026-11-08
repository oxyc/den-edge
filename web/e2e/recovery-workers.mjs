/**
 * Count only Den's real recovery Worker; the full app may own unrelated library and projection Workers.
 *
 * `recoveryWorkers.hold()` keeps every answer a recovery Worker sends from the page until `release()`, so a test acts
 * while a derivation is certainly still in flight. Unheld, a derivation can start and finish between two polls of
 * `active`, which then reads 0 for a Worker that did run.
 */
export async function trackRecoveryWorkers(page) {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const held = [];
    let holding = false;
    const state = {
      active: 0,
      created: 0,
      maximum: 0,
      terminated: 0,
      createdAt: [],
      hold() {
        holding = true;
      },
      /** Deliver what was held to the Workers still running: a terminated Worker's answer never arrives. */
      release() {
        holding = false;
        for (const deliver of held.splice(0)) deliver();
      },
    };
    globalThis.recoveryWorkers = state;
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args);
        if (!/recoveryWorker/i.test(String(args[0]))) return worker;
        state.active++;
        state.created++;
        state.createdAt.push(performance.now());
        state.maximum = Math.max(state.maximum, state.active);
        const terminate = worker.terminate.bind(worker);
        let active = true;
        // Registered before the page's own `onmessage`, so it can keep a message from reaching it.
        worker.addEventListener('message', (event) => {
          if (!holding || event.denReleased) return;
          event.stopImmediatePropagation();
          held.push(() => {
            if (!active) return;
            const again = new MessageEvent('message', { data: event.data });
            again.denReleased = true;
            worker.dispatchEvent(again);
          });
        });
        worker.terminate = () => {
          if (active) {
            active = false;
            state.active--;
            state.terminated++;
          }
          terminate();
        };
        return worker;
      },
    });
  });
}
