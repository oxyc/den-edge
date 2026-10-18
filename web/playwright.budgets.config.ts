import { defineConfig, chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_PORT, E2E_ORIGIN } from './e2e/base-url.mjs';

// The time budgets (`e2e/big-library-budgets.spec.mjs`) against what a phone is served: the production build, its
// few dozen bundled modules rather than the dev server's five hundred, one test at a time on a runner of its own.
// `npm run test:e2e:budgets`; CI's `e2e-budgets` job.
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (
  !process.env.CI &&
  !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH &&
  !existsSync(chromium.executablePath()) &&
  existsSync(systemChrome)
) {
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = systemChrome;
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'big-library-budgets.spec.mjs',
  timeout: 300_000,
  // A budget is time on this machine: nothing else runs beside it.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { baseURL: E2E_ORIGIN },
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/test/seed-library.html`,
    // The build carries the seed page; the preview server proxies nothing real (scripts/upstream.ts).
    env: { DEN_E2E: '1', DEN_E2E_SEED: '1' },
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
