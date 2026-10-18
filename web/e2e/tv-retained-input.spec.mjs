import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test('a remote press after Back wins over a delayed retained-page restoration frame', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.route('**/atlas/manifest.json', (route) =>
    route.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } }),
  );
  await page.route('**/atlas/catalog/**', (route) => route.fulfill({ json: { metas: [] } }));
  await page.route('**/atlas/index/**', (route) => route.fulfill({ status: 404, json: {} }));
  await page.route('**/atlas/recommend**', (route) =>
    route.fulfill({
      json: { version: 1, slides: [1002, 1003, 1004].map((id) => ({ type: 'movie', id })) },
    }),
  );
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const hero = page.locator('[data-route-page][data-active="true"] .billboard');
  await expect(hero.locator('.slide')).toHaveCount(3);
  const more = hero.getByRole('link', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('ArrowRight');
  await expect(hero.getByRole('heading', { name: 'Movie 1003' })).toBeVisible();
  await expect(more).toBeFocused();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Movie 1003', level: 1 })).toBeVisible();

  // Hold the browser's next-frame callbacks across Back, then release them after the viewer's next press.
  // This controls the ordering seen on Linux WebKit without mocking navigation, focus or the actual UI.
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window);
    const pending = [];
    let held = true;
    window.requestAnimationFrame = (callback) =>
      request((time) => {
        if (held) pending.push(callback);
        else callback(time);
      });
    window.__tvPendingFrames = () => pending.length;
    window.__tvReleaseFrames = () => {
      held = false;
      window.requestAnimationFrame = request;
      for (const callback of pending.splice(0)) callback(performance.now());
    };
  });
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/);
  await expect(more).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__tvPendingFrames())).toBeGreaterThan(0);
  await page.keyboard.press('ArrowRight');
  await expect(hero.getByRole('heading', { name: 'Movie 1004' })).toBeVisible();
  await expect(more).toBeFocused();
  await page.evaluate(() => window.__tvReleaseFrames());
  // Let restoration-triggered scroll/intersection notifications run before checking the selected title.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(hero.getByRole('heading', { name: 'Movie 1004' })).toBeVisible();
  await expect(more).toHaveAttribute('href', /\/movie\/1004(?:-|$)/);
  await expect(more).toBeFocused();
});
