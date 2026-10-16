import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const card = (id, title) => ({
  type: 'movie',
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
    if (url.pathname.endsWith('/index/query.json'))
      return route.fulfill({ json: { hits: [{ ...card(101, 'Moomin Magic'), score: 0.91 }] } });
    if (url.pathname.endsWith('/index/filter/all/titles.json'))
      return route.fulfill({
        json: { titles: [card(102, 'Dinosaur Day')], order: 'stable', ignored: [] },
      });
    if (/\/index\/title\/movie\/\d+\.json$/.test(url.pathname)) {
      const id = Number(url.pathname.match(/(\d+)\.json$/)[1]);
      return route.fulfill({
        json: {
          ...card(id, id === 101 ? 'Moomin Magic' : 'Dinosaur Day'),
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
        title: id === 101 ? 'Moomin Magic' : 'Dinosaur Day',
        release_date: '2020-01-01',
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

  await page.goto(`${E2E_ORIGIN}/test/library.html?kid`);

  await expect
    .poll(() => atlasRequests.map((url) => url.pathname))
    .toContain('/atlas/index/kids-home.json');
  await expect(page.getByRole('heading', { name: 'Welcome to Moominvalley' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dino Roars!' })).toBeVisible();
  await expect(page.locator('.billboard')).toContainText('Moomin Magic');
  await expect(page.getByRole('heading', { name: 'Trending' })).toHaveCount(0);
  expect(recommendations).toEqual([]);
  expect(atlasRequests.length).toBeGreaterThan(0);
  for (const url of atlasRequests) {
    expect(url.searchParams.get('maximumAge'), url.href).toBe('12');
    expect(url.searchParams.get('unknownRatings'), url.href).toBe('block');
    expect(url.searchParams.get('kidAudience'), url.href).toBe('child-or-teen');
  }
});
