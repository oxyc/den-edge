import { defineConfig } from '@playwright/test';
import browser from './playwright.config';
import { E2E_ORIGIN, E2E_PORT } from './e2e/base-url.mjs';

const platform = process.env.DEN_TV_PLATFORM ?? 'webos';
const engine = process.env.DEN_TV_TEST_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const output = `dist-tv-${platform}-e2e-${E2E_PORT}`;
if (!['webos', 'tizen'].includes(platform)) throw new Error('Unknown DEN_TV_PLATFORM');

export default defineConfig({
  ...browser,
  testMatch: 'tv-*.spec.mjs',
  testIgnore: ['tv-package-*.spec.mjs'],
  workers: 2,
  outputDir: `./test-results-tv/${platform}-${E2E_PORT}`,
  use: {
    ...browser.use,
    browserName: engine,
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions:
      engine === 'chromium'
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {},
  },
  webServer: {
    // Replacing the browser webServer must preserve its upstream isolation guard for build and preview.
    env: { DEN_E2E: '1' },
    command: `DEN_TV_OUT_DIR=${output} DEN_TV_E2E=1 npm run build:tv:${platform} && DEN_TV_OUT_DIR=${output} npm run preview:tv:${platform} -- --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
