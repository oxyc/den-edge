import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test('real TV Home keeps its hero simple and survives twenty detail/back cycles', async ({
  page,
}, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeGuestEdge(page, newEdge());
  await page.route('**/atlas/manifest.json', (route) =>
    route.fulfill({
      json: {
        id: 'com.den.atlas',
        catalogs: [{ id: 'popular', type: 'movie', name: 'Popular' }],
      },
    }),
  );
  await page.route('**/atlas/catalog/**', (route) => route.fulfill({ json: { metas: [] } }));
  await page.route('**/atlas/index/**', (route) => route.fulfill({ status: 404, json: {} }));
  await page.route('**/atlas/recommend**', (route) =>
    route.fulfill({
      json: {
        version: 1,
        slides: [
          { type: 'movie', id: 1002 },
          { type: 'movie', id: 1003 },
        ],
      },
    }),
  );
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const hero = page.locator('[data-route-page][data-active="true"] .billboard');
  await expect(hero).toContainText('Movie 1002', { timeout: 30_000 });
  await expect(hero.getByRole('heading', { name: 'Movie 1002' })).toBeVisible();
  await expect(hero.locator('.pager, .expand')).toHaveCount(0);
  await expect(hero.getByRole('button', { name: /Watchlist|Seen/ })).toHaveCount(0);
  const more = hero.getByRole('link', { name: 'More', exact: true });
  await expect(more).toHaveCount(1);
  await more.focus();
  await page.screenshot({ path: info.outputPath('tv-home.png') });
  await page.keyboard.press('ArrowRight');
  await expect(hero.getByRole('heading', { name: 'Movie 1003' })).toBeVisible();
  await expect(hero.getByRole('link', { name: 'More', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(hero.getByRole('heading', { name: 'Movie 1002' })).toBeVisible();
  await expect(more).toBeFocused();
  const baselineWorkers = page.workers().length;
  for (let cycle = 0; cycle < 20; cycle++) {
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/movie\/1002(?:-|$)/);
    await expect(page.getByRole('heading', { name: 'Movie 1002', level: 1 })).toBeVisible();
    if (cycle === 0) await page.screenshot({ path: info.outputPath('tv-detail.png') });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
    await expect(more).toBeFocused();
    expect(page.workers().length).toBeLessThanOrEqual(Math.max(1, baselineWorkers));
  }
  expect(errors).toEqual([]);
});
