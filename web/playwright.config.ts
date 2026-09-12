import { defineConfig, chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

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
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198/test/router.html',
    reuseExistingServer: !process.env.CI,
  },
});
