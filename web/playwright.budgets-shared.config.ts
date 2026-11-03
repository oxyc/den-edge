import { defineConfig } from '@playwright/test';
import budgets from './playwright.budgets.config';
import { E2E_PORT, E2E_ORIGIN } from './e2e/base-url.mjs';
import { bridgeUpstreams } from './e2e/shared-worker-bridge.mjs';

// The time budgets with the library in a SharedWorker, as an iPhone's Safari and a desktop browser run it
// (`e2e/big-library-shared-worker.spec.mjs`). `playwright.budgets.config.ts` keeps every Worker a dedicated one, which
// its Worker counters can see; here the build keeps the SharedWorker, and its den-edge goes through the spec's bridge.
// `npm run test:e2e:budgets:shared`.
export default defineConfig({
  ...budgets,
  testMatch: ['big-library-shared-worker.spec.mjs'],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/test/seed-library.html`,
    env: { DEN_E2E: '1', DEN_E2E_SEED: '1', DEN_E2E_SHARED_WORKER: '1', ...bridgeUpstreams },
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
