import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const card = (id, title, type = 'movie') => ({
  type,
  id,
  title,
  year: 2020,
  posterPath: '/poster.jpg',
  genreIds: [16, 10751],
  originalLanguage: 'en',
});

test('Kid Home uses its child-facing catalogue and billboard under the Kid policy', async ({
  page,
}) => {
  await guardNetwork(page);
  const atlasRequests = [];
  const recommendations = [];
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/metadata/title/query', (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/atlas/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/manifest.json'))
      return route.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } });
    atlasRequests.push(url);
    if (url.pathname.endsWith('/index/kids-home.json'))
      return route.fulfill({
        json: {
          rows: [
            {
              id: 'moomins',
              title: 'Welcome to Moominvalley',
              group: 'favorite-worlds',
              source: { kind: 'query', query: 'Moomins', minimum_score: 0.69 },
            },
            {
              id: 'bluey',
              title: 'Bluey Time!',
              group: 'favorite-worlds',
              source: {
                kind: 'query',
                query: 'Bluey',
                minimum_score: 0.9,
                affinity: [{ type: 'series', id: 82728 }],
              },
            },
            {
              id: 'dino-roars',
              title: 'Dino Roars!',
              group: 'big-adventures',
              source: {
                kind: 'filter',
                type: 'all',
                selection: ['audience:made_for_children'],
              },
            },
          ],
        },
      });
    if (url.pathname.endsWith('/index/query.json')) {
      const bluey = url.searchParams.get('q') === 'Bluey';
      return route.fulfill({
        json: {
          hits: [
            {
              ...card(
                bluey ? 82728 : 101,
                bluey ? 'Bluey' : 'Moomin Magic',
                bluey ? 'series' : 'movie',
              ),
              score: bluey ? 2.11 : 0.91,
            },
          ],
        },
      });
    }
    if (url.pathname.endsWith('/index/filter/all/titles.json'))
      return route.fulfill({
        json: { titles: [card(102, 'Dinosaur Day')], order: 'stable', ignored: [] },
      });
    if (/\/index\/title\/(movie|series)\/\d+\.json$/.test(url.pathname)) {
      const id = Number(url.pathname.match(/(\d+)\.json$/)[1]);
      return route.fulfill({
        json: {
          ...card(
            id,
            id === 82728 ? 'Bluey' : id === 101 ? 'Moomin Magic' : 'Dinosaur Day',
            id === 82728 ? 'series' : 'movie',
          ),
          indexed: true,
          eligible: true,
          minimumAge: 0,
          maturityRatings: [],
        },
      });
    }
    if (url.pathname.includes('/recommend')) {
      recommendations.push(url.pathname);
      return route.fulfill({ json: { version: 1, slides: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await routeTmdb(page, (route) => {
    const match = /\/(movie|tv)\/(\d+)$/.exec(new URL(route.request().url()).pathname);
    if (!match) return route.fulfill({ json: { results: [], total_pages: 1 } });
    const id = Number(match[2]);
    return route.fulfill({
      json: {
        id,
        ...(match[1] === 'tv'
          ? { name: id === 82728 ? 'Bluey' : 'Dinosaur Day', first_air_date: '2018-10-01' }
          : { title: id === 101 ? 'Moomin Magic' : 'Dinosaur Day', release_date: '2020-01-01' }),
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        genres: [{ id: 16, name: 'Animation' }],
        overview: 'A child-friendly adventure.',
        credits: { cast: [], crew: [] },
        videos: { results: [] },
        external_ids: {},
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"/>',
    }),
  );

  await page.goto(`${E2E_ORIGIN}/test/library.html?kid&populated&bluey`);

  await expect
    .poll(() => atlasRequests.map((url) => url.pathname))
    .toContain('/atlas/index/kids-home.json');
  await expect(page.getByRole('heading', { name: 'Bluey Time!' })).toBeVisible();
  // Moominvalley is first in the catalogue fixture. It is either still outside the two-row lazy window or follows
  // Bluey in the DOM, proving that recent Kid activity ranked Bluey's world ahead of its static position.
  await expect
    .poll(async () => {
      const headings = await page.locator('h2').allTextContents();
      const bluey = headings.indexOf('Bluey Time!');
      const moomins = headings.indexOf('Welcome to Moominvalley');
      return bluey >= 0 && (moomins < 0 || bluey < moomins);
    })
    .toBe(true);
  // The watched Bluey itself stays out of the billboard even though its world now leads Home.
  await expect(page.locator('.billboard')).not.toContainText('Bluey');
  await expect(page.getByRole('heading', { name: 'Trending' })).toHaveCount(0);
  expect(recommendations).toEqual([]);
  expect(atlasRequests.length).toBeGreaterThan(0);
  for (const url of atlasRequests) {
    expect(url.searchParams.get('maximumAge'), url.href).toBe('12');
    expect(url.searchParams.get('unknownRatings'), url.href).toBe('block');
    expect(url.searchParams.get('kidAudience'), url.href).toBe('child-or-teen');
  }
});
