import { defineConfig } from '@playwright/test';
import browser from './playwright.config';
import { E2E_ORIGIN, E2E_PORT } from './e2e/base-url.mjs';

const output = `dist-tv-tizen-package-e2e-${E2E_PORT}`;
export default defineConfig({
  ...browser,
  testMatch: 'tv-package-*.spec.mjs',
  testIgnore: [],
  workers: 2,
  outputDir: `./test-results-tv/package-${E2E_PORT}`,
  use: {
    ...browser.use,
    viewport: { width: 1920, height: 1080 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: `DEN_TV_PACKAGED=1 DEN_TV_API_ORIGIN=https://den-tv-api.example.invalid DEN_TV_OUT_DIR=${output} DEN_TV_E2E=1 npm run build:tv:tizen && E2E_PORT=${E2E_PORT} DEN_TV_OUT_DIR=${output} node scripts/tv-static-preview.mjs`,
    url: `${E2E_ORIGIN}/package/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
