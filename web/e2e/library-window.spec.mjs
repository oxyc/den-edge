import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { recordFrameGeometryReads } from './frame-geometry-reads.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

test('large fixed library shelves mount a bounded card window', async ({ page }) => {
  await recordFrameGeometryReads(page);
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => {
    const id = Number(new URL(route.request().url()).pathname.match(/\/(?:movie|tv)\/(\d+)$/)?.[1]);
    return route.fulfill({
      json: id
        ? {
            id,
            title: `Movie ${id}`,
            poster_path: '/poster.jpg',
            release_date: '2026-01-01',
            vote_average: 7.5,
            vote_count: 500,
            genre_ids: [18],
          }
        : { page: 1, total_pages: 1, results: [] },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/library.html?populated&many=200`);
  const row = page.getByRole('region', { name: 'Continue Watching', exact: true });
  await expect(row).toBeVisible();
  // The fixture pre-names its 200 measured titles. The older unnamed base title stays dormant until intent,
  // instead of making the initial reactive shelf publication larger.
  await expect(row.locator('[data-card-index]')).toHaveCount(200);
  await expect.poll(() => row.locator('.card').count()).toBeGreaterThan(0);
  expect(await row.locator('.card').count()).toBeLessThan(20);
  const measured = await row.evaluate((node) => ({
    cards: node.querySelectorAll('.card').length,
    slots: node.querySelectorAll('[data-card-index]').length,
    rowNodes: node.querySelectorAll('*').length,
  }));
  expect(measured.rowNodes).toBeLessThan(800);
  expect(await page.locator('*').count()).toBeLessThan(4_000);

  await row
    .locator('[data-card-index="100"] .proxy')
    .evaluate((node) => node.focus({ preventScroll: true }));
  await expect(row.locator('[data-card-index="100"] .card')).toBeFocused();

  await page.evaluate(() => window.takeFrameGeometryReads());
  await row.locator('.track').evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(row.locator('[data-card-index="200"] .card')).toHaveCount(1);
  await expect(row.locator('[data-card-index="0"] .card')).toHaveCount(0);
  expect(await row.locator('.card').count()).toBeLessThan(20);
  expect(await page.evaluate(() => window.takeFrameGeometryReads())).toEqual([]);

  await page.goto(`${E2E_ORIGIN}/test/library.html?populated&many=200&sparse-many`);
  const sparse = page.getByRole('region', { name: 'Continue Watching', exact: true });
  await expect(sparse).toBeVisible();
  // A title cached far down the shelf must not jump ahead of unnamed titles or cause a 200-title lookup burst.
  await expect(sparse.locator('[data-card-index]')).toHaveCount(8);
  await sparse.locator('.track').evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(sparse.locator('[data-card-index]')).toHaveCount(16);
  await expect(sparse.getByRole('link', { name: 'Measured movie 1', exact: true })).toHaveCount(0);
});

test('Home keeps admitting Watchlist titles as the viewer scrolls', async ({ page }) => {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => {
    const id = Number(new URL(route.request().url()).pathname.match(/\/movie\/(\d+)$/)?.[1]);
    return route.fulfill({
      json: {
        id,
        title: `Movie ${id}`,
        poster_path: '/poster.jpg',
        release_date: '2026-01-01',
        vote_average: 7.5,
        vote_count: 500,
        genre_ids: [18],
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&many=40&many-watchlist&unnamed-many`,
  );

  const row = page.getByRole('region', { name: 'Watchlist', exact: true });
  const slots = row.locator('[data-card-index]');
  await expect(slots).toHaveCount(8);
  for (const count of [16, 24, 32, 40]) {
    await row.locator('.track').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
      node.dispatchEvent(new Event('scroll'));
    });
    await expect(slots).toHaveCount(count);
  }
});
