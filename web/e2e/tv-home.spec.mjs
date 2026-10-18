import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test('real TV Home keeps its hero simple and survives forty detail/back cycles', async ({
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
          { type: 'movie', id: 1004 },
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
  // The first enriched recommendation renders before the others. Wait for the real slides before asking
  // the remote to page; an early ArrowRight correctly has nowhere to go and must not be queued speculatively.
  await expect(hero.locator('.slide')).toHaveCount(3);
  const more = hero.getByRole('link', { name: 'More', exact: true });
  await expect(more).toHaveCount(1);
  // Reach the hero from the navbar exactly as a remote does; direct DOM focus masked geometry regressions.
  const approach = ['ArrowUp', 'ArrowRight', 'ArrowLeft', 'ArrowDown'];
  for (
    let press = 0;
    press < 32 && !(await more.evaluate((node) => node === document.activeElement));
    press++
  ) {
    await page.keyboard.press(approach[press % approach.length]);
    await page.waitForTimeout(80);
  }
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('data-tv-carousel-action', 'hero');
  await page.screenshot({ path: info.outputPath('tv-home.png') });
  const baselineWorkers = page.workers().length;
  const heroPagingMs = [];
  const pageHero = async (key, title) => {
    const heading = hero.getByRole('heading', { name: title });
    await expect(hero.getByRole('link', { name: 'More', exact: true })).toBeFocused();
    const started = performance.now();
    await page.keyboard.press(key);
    await expect(heading).toBeVisible();
    await expect(hero.getByRole('link', { name: 'More', exact: true })).toBeFocused();
    heroPagingMs.push(performance.now() - started);
  };
  for (let cycle = 0; cycle < 40; cycle++) {
    const titleId = 1002 + (cycle % 3);
    if (cycle > 0) {
      if (cycle % 3 === 0) {
        await pageHero('ArrowLeft', 'Movie 1003');
        await pageHero('ArrowLeft', 'Movie 1002');
      } else await pageHero('ArrowRight', `Movie ${titleId}`);
    }
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/movie/${titleId}(?:-|$)`));
    await expect(page.getByRole('heading', { name: `Movie ${titleId}`, level: 1 })).toBeVisible();
    expect(await page.locator('[data-route-page]').count()).toBeLessThanOrEqual(4);
    if (cycle === 0) await page.screenshot({ path: info.outputPath('tv-detail.png') });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
    await expect(more).toBeFocused();
    expect(await page.locator('[data-route-page]').count()).toBeLessThanOrEqual(3);
    expect(page.workers().length).toBeLessThanOrEqual(Math.max(1, baselineWorkers));
  }

  await info.attach('tv-hero-paging-latency.json', {
    body: Buffer.from(JSON.stringify(heroPagingMs, null, 2)),
    contentType: 'application/json',
  });

  expect(errors).toEqual([]);
});
