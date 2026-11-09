// The real Browser/LG/webOS/supported-Tizen composition: Library mounts Detail, owns the playback boundary and
// supplies Continue from the active profile. A known-future title with no current-series Continue must stop there,
// before the player or source addon, even when another series has a newer overlapping S1E1 Continue coordinate.
import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const series = (id, firstAir) => ({
  id,
  name: id === 2007 ? 'Future Series' : 'Other Series',
  ...(firstAir ? { first_air_date: firstAir } : {}),
  overview: 'A production playback-boundary fixture.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  external_ids: { imdb_id: `tt${id}` },
  vote_average: 7.5,
  vote_count: 500,
  genres: [{ id: 18, name: 'Drama' }],
  seasons: [{ season_number: 1, name: 'Season 1', episode_count: 2 }],
  last_episode_to_air: null,
  aggregate_credits: { cast: [], crew: [] },
  recommendations: { results: [] },
});

async function open(page, { firstAir = '2099-01-01', query = '' } = {}) {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  const sourceRequests = [];
  await page.route('**/den/fixture/**', (route) => {
    sourceRequests.push(route.request().url());
    return route.fulfill({ status: 503, json: { error: 'unexpected_source_request' } });
  });
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/season/'))
      return route.fulfill({
        json: {
          episodes: [1, 2].map((episode) => ({
            episode_number: episode,
            name: `Episode ${episode}`,
            air_date: '2025-01-01',
          })),
        },
      });
    const id = Number(path.match(/\/tv\/(\d+)/)?.[1] ?? 2007);
    return route.fulfill({ json: series(id, id === 2007 ? firstAir : '2020-01-01') });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?play-boundary&address&populated&page=title&type=tv&id=2007${query}`,
  );
  await expect(page.getByRole('heading', { name: 'Future Series', level: 1 })).toBeVisible();
  return sourceRequests;
}

test('a future series without current Continue performs zero production player or source requests', async ({
  page,
}) => {
  const sourceRequests = await open(page, {
    query: '&other-series-continue&direct-play',
  });
  const hero = page.locator('header.hero');

  await expect(hero.getByRole('link', { name: /^(Play|Resume)$/ })).toHaveCount(0);
  await expect(hero.getByRole('button', { name: 'Sources', exact: true })).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.denTestPlayBoundary.stats())).toMatchObject({ asked: 0 });
  expect(sourceRequests).toEqual([]);
});

test('a real current-series Continue still crosses the future-title playback boundary', async ({
  page,
}) => {
  await open(page, { query: '&current-series-continue&direct-play' });
  await expect
    .poll(() => page.evaluate(() => window.denTestPlayBoundary.stats().asked))
    .toBeGreaterThan(0);
});

test('an explicitly addressed future-series episode still crosses the playback boundary', async ({
  page,
}) => {
  await open(page, { query: '&episode&season=1&direct-play' });
  await expect
    .poll(() => page.evaluate(() => window.denTestPlayBoundary.stats().asked))
    .toBeGreaterThan(0);
});

for (const [label, firstAir] of [
  ['unknown', null],
  ['aired', '2020-01-01'],
])
  test(`${label} first-air metadata keeps the title fallback playable`, async ({ page }) => {
    await open(page, { firstAir });
    await expect(
      page.locator('header.hero').getByRole('link', { name: 'Play', exact: true }),
    ).toBeVisible();
  });
