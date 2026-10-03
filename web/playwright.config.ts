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

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  // Files are isolated by Playwright contexts and do not share mutable server state.
  // Keep local runs deterministic while allowing CI to execute independent files in parallel.
  workers: process.env.CI ? 2 : 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: E2E_ORIGIN,
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/test/router.html`,
    // A busy port means another worktree's server is already there — fail loudly (--strictPort
    // backs this up) instead of silently reusing it and running tests against the wrong code.
    reuseExistingServer: false,
  },
});
