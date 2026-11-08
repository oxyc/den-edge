/** Count only Den's real recovery Worker; the full app may own unrelated library and projection Workers. */
export async function trackRecoveryWorkers(page) {
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const state = { active: 0, created: 0, maximum: 0, terminated: 0, createdAt: [] };
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
