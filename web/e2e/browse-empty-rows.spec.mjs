// Home's rows when every one comes back empty, as every catalog does with no titles to give or when a profile's
// filters remove them all. An empty row hides itself and takes no height, so the bottom of the screen stays in view:
// the screen must still stop adding rows, rather than mount every row it has and ask for each one's page.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

const ROW_QUERY = /^\/tmdb\/3\/(?:discover|trending|movie|tv)\//;

test('a Home of empty rows stops asking for rows', async ({ page }) => {
  await routeGuestEdge(page, newEdge());
  const asked = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === E2E_ORIGIN && ROW_QUERY.test(url.pathname))
      asked.add(url.pathname + url.search);
  });
  await page.goto(`${E2E_ORIGIN}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect.poll(() => asked.size, { timeout: 30_000 }).toBeGreaterThan(0);
  // Time for the screen to have added every row it was going to: before the fix it had asked for 125 by now.
  await page.waitForTimeout(5_000);
  expect(
    await page.locator('main a[href^="/movie/"], main a[href^="/tv/"]').count(),
    'the rows are empty here, which is what this test is about',
  ).toBe(0);
  expect(asked.size, 'row pages asked for').toBeLessThan(30);
});
