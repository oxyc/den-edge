import { defineConfig } from '@playwright/test';
import browser from './playwright.config';

// The packaged Samsung app against a den-edge on another origin over real HTTPS, so its CORS preflights are the
// browser's own (`e2e/tv-cross-origin-home.measure.mjs`). The household is made on the dev server; the packages
// it measures are built beforehand and served by the spec.
export default defineConfig({
  ...browser,
  testMatch: 'tv-cross-origin-*.measure.mjs',
  testIgnore: [],
  workers: 1,
  timeout: 3_600_000,
  outputDir: './test-results-tv/cross-origin',
});
