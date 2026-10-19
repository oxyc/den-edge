import { defineConfig } from '@playwright/test';
import browser from './playwright.config';
import { E2E_ORIGIN, E2E_PORT } from './e2e/base-url.mjs';

const output = `dist-keyboard-e2e-${E2E_PORT}`;
const engine = process.env.DEN_KEYBOARD_TEST_ENGINE === 'webkit' ? 'webkit' : 'chromium';

export default defineConfig({
  ...browser,
  testDir: './e2e',
  testMatch: '**/keyboard-enhancement.spec.mjs',
  testIgnore: [],
  outputDir: `./test-results-keyboard/${E2E_PORT}`,
  use: {
    ...browser.use,
    browserName: engine,
    // The once-only CI job intentionally uses the runner's Chrome rather than downloading Playwright's copy.
    // Never pass that Chromium executable to the optional WebKit run.
    launchOptions:
      engine === 'chromium'
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {},
  },
  webServer: {
    command: `npx vite build --outDir ${output} && npx vite preview --outDir ${output} --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
  },
});
