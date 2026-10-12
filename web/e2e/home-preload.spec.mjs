import { test, expect } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// The parser-time lead (index.html's inline script) can be adopted and fully loaded before the billboard's titles
// arrive. Billboard then reports its hero ready in the same flush as the lead's arrival; Home must still count
// that as ready, preload its next screens and start background work a second later — measured on d.oxy.fi, it
// did neither, and a tap waited for the Detail chunk.
test('a lead already painted before the billboard arrives still readies Home', async ({ page }) => {
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', (r) =>
    r.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } }),
  );
  await page.route('**/atlas/catalog/**', (r) => r.fulfill({ json: { metas: [] } }));
  await page.route('**/atlas/index/**', (r) =>
    r.fulfill({
      json: r.request().url().includes('suggest') ? { perSeed: [], pooled: [] } : { labels: [] },
    }),
  );
  await page.route('**/atlas/index/filter/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#264c68"/></svg>',
    }),
  );
  await routeTmdb(page, (r) => {
    const match = /\/(movie|tv)\/(\d+)$/.exec(new URL(r.request().url()).pathname);
    if (!match) return r.fulfill({ json: { results: [], total_pages: 1 } });
    return r.fulfill({
      json: {
        id: Number(match[2]),
        title: `Film ${match[2]}`,
        release_date: '2026-01-01',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        genres: [{ id: 18, name: 'Drama' }],
        overview: 'A movie description.',
      },
    });
  });
  // The billboard's titles arrive only once the lead below has loaded.
  let releaseBillboard;
  const billboard = new Promise((resolve) => (releaseBillboard = resolve));
  await page.route('**/atlas/recommend**', async (r) => {
    await billboard;
    await r.fulfill({ json: { version: 1, slides: [{ type: 'movie', id: 501 }] } });
  });
  // What the parser-time script leaves in the document for a kept lead: its image, already requested.
  await page.route('**/test/nav-search.html*', async (route) => {
    const html = await (await route.fetch()).text();
    await route.fulfill({
      contentType: 'text/html',
      body: html.replace(
        '<div id="app">',
        '<div data-den-early-billboard><div data-den-early-picture><img class="lit" data-den-early-backdrop' +
          ' data-path="/backdrop.jpg" src="https://image.tmdb.org/t/p/w1280/backdrop.jpg" alt="" /></div></div>' +
          '<div id="app">',
      ),
    });
  });
  const detailAsked = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/src/components/Detail.svelte')
      detailAsked.push(Date.now());
  });

  await page.goto(`${E2E_ORIGIN}/test/nav-search.html?fixtureGuest=1`);
  await expect(page.locator('img[data-den-early-backdrop].backdrop')).toBeAttached();
  await page.waitForFunction(() => {
    const image = document.querySelector('img[data-den-early-backdrop]');
    return image?.complete && image.naturalWidth > 0;
  });
  await page.evaluate(async () => {
    const { ProfileSession } = await import('/src/lib/profileSession.svelte.ts');
    const ready = ProfileSession.prototype.foregroundReady;
    ProfileSession.prototype.foregroundReady = function () {
      window.foregroundReadyAt ??= performance.now();
      return ready.call(this);
    };
  });
  expect(detailAsked).toEqual([]);

  const released = await page.evaluate(() => performance.now());
  releaseBillboard();
  await expect(page.locator('[data-route-page][data-active="true"] .billboard')).toContainText(
    'Film 501',
  );
  await expect.poll(() => detailAsked.length, { timeout: 5_000 }).toBeGreaterThan(0);
  // A second after the hero (PROVIDERS_AFTER_HERO_MS), not RoutedLibrary's ten-second fallback.
  await expect
    .poll(() => page.evaluate(() => window.foregroundReadyAt ?? null), { timeout: 5_000 })
    .not.toBeNull();
  const after = (await page.evaluate(() => window.foregroundReadyAt)) - released;
  expect(after).toBeGreaterThan(900);
  expect(after).toBeLessThan(4_000);
});
