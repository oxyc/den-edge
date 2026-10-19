import { defineConfig } from '@playwright/test';
import browser from './playwright.config';
import { E2E_ORIGIN, E2E_PORT } from './e2e/base-url.mjs';

const output = `dist-keyboard-e2e-${E2E_PORT}`;

export default defineConfig({
  ...browser,
  testDir: './e2e',
  testMatch: '**/keyboard-enhancement.spec.mjs',
  testIgnore: [],
  outputDir: `./test-results-keyboard/${E2E_PORT}`,
  use: {
    ...browser.use,
    browserName: process.env.DEN_KEYBOARD_TEST_ENGINE === 'webkit' ? 'webkit' : 'chromium',
  },
  webServer: {
    command: `npx vite build --outDir ${output} && npx vite preview --outDir ${output} --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
  },
});
