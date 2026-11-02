import { defineConfig } from '@playwright/test';
import browser, { PRODUCTION_BUILD_SPECS } from './playwright.config';
import { E2E_ORIGIN, E2E_PORT } from './e2e/base-url.mjs';

// The specs whose profile household waits on its library Workers' startup (`PRODUCTION_BUILD_SPECS`), against the
// build a browser is served rather than the dev server's unbundled modules. `npm run test:e2e:production`; CI's
// `e2e (production build)` job.
export default defineConfig({
  ...browser,
  testMatch: PRODUCTION_BUILD_SPECS,
  testIgnore: [],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/test/seed-library.html`,
    // The build carries the seed page; the preview server proxies nothing real (scripts/upstream.ts).
    env: { DEN_E2E: '1', DEN_E2E_SEED: '1' },
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
