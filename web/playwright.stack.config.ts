import { defineConfig } from '@playwright/test';

// The cross-repo playback e2e (`e2e-stack/`): the real den-edge and den-hearth, started once for the file by the spec
// itself (`stack.mjs`), so there is no web server here. One worker: the stack is one household on fixed ports.
export default defineConfig({
  testDir: './e2e-stack',
  timeout: 120_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  outputDir: './test-results-stack',
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
});
