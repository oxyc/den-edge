import { defineConfig, chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_PORT, E2E_ORIGIN } from './e2e/base-url.mjs';

// Reuse the installed browser on macOS when Playwright's bundled browser is absent.
// CI always installs its pinned Chromium; an explicit executable override still wins.
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (
  !process.env.CI &&
  !process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH &&
  !existsSync(chromium.executablePath()) &&
  existsSync(systemChrome)
) {
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = systemChrome;
}

// Linux WebKit paints through Skia's GPU path. Without a GPU (CI's runners) that path sets itself
// up on the main thread the first time a page paints a CSS filter: a second or more with no frames,
// in every freshly launched browser, which no browser Den serves pays. Paint on the CPU, as such a
// machine would. Set here so the workers, and the browsers specs launch themselves, inherit it.
if (process.platform === 'linux') process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING ??= '1';

export default defineConfig({
  testDir: './e2e',
  // Time budgets measure the production build on a runner of their own (`playwright.budgets.config.ts`).
  testIgnore: [
    'tv-*.spec.mjs',
    'keyboard-enhancement.spec.mjs',
    'big-library-budgets.spec.mjs',
    'big-library-first-open.spec.mjs',
  ],
  timeout: 120_000,
  // Files are isolated by Playwright contexts and do not share mutable server state.
  // Keep local runs deterministic while allowing CI to execute independent files in parallel.
  // GitHub's public ubuntu-latest runner has four CPUs. Keep local runs conservative,
  // but use the runner rather than leaving half of it idle.
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL: E2E_ORIGIN,
    // Apply bounded steps to fixture pages and browsers launched directly by a spec. Without these, a missed
    // readiness state consumes the entire test timeout and reports no useful action or navigation call log.
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/test/router.html`,
    // The dev server proxies unrouted requests to a real den-edge unless told this is a test (scripts/upstream.ts).
    env: { DEN_E2E: '1' },
    // A busy port means another worktree's server is already there — fail loudly (--strictPort
    // backs this up) instead of silently reusing it and running tests against the wrong code.
    reuseExistingServer: false,
  },
});
