import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

/**
 * The library fixture at `query`, every title named by a stand-in TMDB. Series have one season of three episodes, all
 * aired, but Series 2002, which has two (8 and 10) aired to S2E6: its seen S2E4 leaves S2E5 to watch next.
 */
async function open(browser, query) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 852 },
    reducedMotion: 'reduce',
  });
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (route) => {
    const [, type, id] =
      new URL(route.request().url()).pathname.match(/\/(movie|tv)\/(\d+)$/) ?? [];
    if (!id) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    return route.fulfill({
      json: {
        id: Number(id),
        ...(type === 'movie'
          ? { title: `Movie ${id}` }
          : id === '2002'
            ? {
                name: `Series ${id}`,
                seasons: [
                  { season_number: 1, episode_count: 8 },
                  { season_number: 2, episode_count: 10 },
                ],
                last_episode_to_air: { season_number: 2, episode_number: 6 },
              }
            : {
                name: `Series ${id}`,
                seasons: [{ season_number: 1, episode_count: 3 }],
                last_episode_to_air: { season_number: 1, episode_number: 3 },
              }),
        poster_path: '/poster.jpg',
        release_date: '2019-01-01',
        first_air_date: '2019-01-01',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18, name: 'Drama' }],
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="blue"/></svg>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/library.html?${query}`);
  return page;
}

// A finished series put back on the watchlist is the newest thing on it. Its `addedAt` is the first time it entered the
// library (every merge keeps the earliest), so only the status stamp of the new listing can put it first.
test('a finished series listed again leads Home’s Watchlist', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser, 'populated&series-kinds&relisted');

    // Series 2006 entered the library at 1, before everything else here, and was listed again at 9500.
    const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
    await expect(watchlist.locator('.name')).toHaveText([
      'Series 2006',
      'Series 2005',
      'Series 2004',
      'Movie 1002',
    ]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

// The Watchlist page's grid holds every listed title Continue Watching does not: a finished series listed again is
// there, a listed series being watched is on Continue instead.
test('the Watchlist page lists a finished series listed again, not one Continue Watching shows', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser, 'populated&page=watchlist&relisted');

    const resume = page.getByRole('region', { name: 'Continue Watching', exact: true });
    await expect(resume.getByRole('link', { name: /Series 2002/ })).toBeVisible();
    const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
    await expect(watchlist.locator('.name')).toHaveText([
      'Series 2006',
      'Series 2001',
      'Movie 1002',
    ]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});
