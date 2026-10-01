import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

// Opening a title from a row while TMDB has yet to answer: the title's own page shows at once, as its skeleton,
// rather than the page just left being held over it under a spinner until the answer comes.
test('a title opens on its own skeleton, with no cover of the page it was opened from', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="blue"/></svg>',
    }),
  );
  let releaseTitle;
  const titleReady = new Promise((r) => (releaseTitle = r));
  await routeTmdb(page, async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/person/7/combined_credits'))
      return r.fulfill({
        json: {
          cast: [
            {
              id: 43,
              media_type: 'movie',
              title: 'Another Movie',
              poster_path: '/another.jpg',
              release_date: '2025-01-01',
            },
          ],
          crew: [],
        },
      });
    if (path.endsWith('/movie/43')) {
      await titleReady;
      return r.fulfill({
        json: {
          id: 43,
          title: 'Another Movie',
          poster_path: '/another.jpg',
          release_date: '2025-01-01',
          recommendations: { results: [] },
        },
      });
    }
    return r.fulfill({
      json: {
        id: 42,
        title: 'The Movie',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        release_date: '2026-01-01',
        credits: { cast: [{ id: 7, name: 'An Actor', profile_path: '/actor.jpg' }] },
        recommendations: { results: [] },
      },
    });
  });
  await page.addInitScript(() => history.replaceState(null, '', '/movie/42'));
  await page.goto('http://127.0.0.1:5198/test/actual-routes.html');
  await expect(page.locator('[data-active="true"] h1')).toHaveText('The Movie');
  const card = page
    .locator('[data-active="true"]')
    .getByRole('link', { name: /^Another Movie/ })
    .first();
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('img')).toBeVisible();
  // Any cover at all, however briefly, is what this guards against.
  await page.evaluate(() => {
    window.covered = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-loading-snapshot]')) window.covered = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await card.tap();
  const loading = page.locator('[data-active="true"] [aria-label="Loading title"]');
  await expect(loading).toHaveCount(1);
  await expect(page.locator('[data-loading-snapshot]')).toHaveCount(0);
  // The hero stands in with the very poster the card was showing, which needs no request, so no spinner.
  await expect(loading.locator('img.seed-still')).toHaveAttribute(
    'src',
    'https://image.tmdb.org/t/p/w342/another.jpg',
  );
  await expect(loading.locator('.spinner')).toHaveCount(0);
  releaseTitle();
  await expect(page.locator('[data-active="true"] h1')).toHaveText('Another Movie');
  expect(await page.evaluate(() => window.covered)).toBe(false);
  await page.close();
});
