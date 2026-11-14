import { access } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import browser, { PRODUCTION_BUILD_SPECS } from '../playwright.config';
import production from '../playwright.production.config';

describe('production Playwright specs', () => {
  test('routes every allowlisted spec exclusively through the production build', async () => {
    expect(PRODUCTION_BUILD_SPECS).toContain('future-premiere.spec.mjs');
    expect(production.testMatch).toEqual(PRODUCTION_BUILD_SPECS);

    for (const spec of PRODUCTION_BUILD_SPECS) {
      await expect(access(new URL(`../e2e/${spec}`, import.meta.url))).resolves.toBeUndefined();
      expect(browser.testIgnore).toContain(spec);
    }
  });
});
