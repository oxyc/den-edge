import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

// After the load, how each screen drew is reported as it is left, in the tvOS app's stalls event: a screen whose
// main thread stalled names itself, its stalls and its frames; one that drew smoothly sends nothing.

test('a screen that stalled is reported once as it is left, with its frames', async ({ page }) => {
  await routeGuestEdge(page, newEdge());
  await page.route('**/atlas/manifest.json', (route) =>
    route.fulfill({
      json: { id: 'com.den.atlas', catalogs: [{ id: 'popular', type: 'movie', name: 'Popular' }] },
    }),
  );
  const named = [2001, 2002, 2003].map((id) => ({
    type: 'movie',
    id,
    title: `Movie ${id}`,
    posterPath: `/poster-${id}.jpg`,
    year: 2026,
  }));
  await page.route('**/atlas/catalog/**', (route) => route.fulfill({ json: { metas: [] } }));
  await page.route('**/atlas/index/**', (route) =>
    route.fulfill({ json: { titles: named, total: named.length } }),
  );
  await page.route('**/atlas/recommend**', (route) =>
    route.fulfill({ json: { version: 1, slides: [{ type: 'movie', id: 1002 }] } }),
  );
  const events = [];
  await page.route('**/performance/event', (route) => {
    events.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.fulfill({ status: 204 });
  });

  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const card = page.getByRole('region', { name: 'Mind-Bending' }).getByRole('link').first();
  await expect(card).toBeAttached({ timeout: 30_000 });
  // Home's main thread blocked for 300 ms, as a heavy rebuild would.
  await page.evaluate(() => {
    const until = performance.now() + 300;
    while (performance.now() < until);
  });
  await page.waitForTimeout(500);
  expect(events, 'nothing is sent while the screen is still showing').toEqual([]);
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/movie\/2001/);
  await expect.poll(() => events.length).toBe(1);
  const [event] = events;
  expect(event).toMatchObject({
    platform: 'webos',
    journey: 'navigation',
    stage: 'stalls',
    route: 'home',
    memory: { warnings: 0 },
  });
  expect(event.stalls[0]).toBeGreaterThanOrEqual(1);
  expect(event.stalls[2]).toBeGreaterThanOrEqual(250);
  expect(event.frames.delivered).toBeGreaterThan(0);
  expect(event.frames.longestMs).toBeGreaterThanOrEqual(250);
});
