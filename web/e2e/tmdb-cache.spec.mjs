import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('prunes an expired answer with a key-only IndexedDB cursor', async ({ page }) => {
  await page.route('**/tmdb/3/movie/603**', (route) =>
    route.fulfill({ json: { id: 603, title: 'The Matrix' } }),
  );
  await page.goto(`${E2E_ORIGIN}/test/tmdb-cache.html`);
  const result = await page.evaluate(() => window.exerciseTmdbPrune());

  expect(result.keys).not.toContain('expired');
  expect(result.keys).toHaveLength(1);
});
