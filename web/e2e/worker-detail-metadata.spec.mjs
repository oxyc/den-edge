import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/worker-detail.html`;
const artwork =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#345"/></svg>';

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function titleBody(id) {
  return {
    id,
    name: `Series ${id}`,
    first_air_date: '2024-01-01',
    backdrop_path: `/backdrop-${id}.jpg`,
    poster_path: `/poster-${id}.jpg`,
    overview: `Description for ${id}.`,
    vote_average: 7.5,
    vote_count: 500,
    genres: [{ id: 18, name: 'Drama' }],
    seasons: [{ season_number: 1, name: 'Season 1', episode_count: 2 }],
    last_episode_to_air: { season_number: 1, episode_number: 2 },
    aggregate_credits: { cast: [], crew: [] },
    credits: { cast: [], crew: [] },
    recommendations: { page: 1, total_pages: 1, results: [] },
    videos: { results: [] },
    external_ids: { imdb_id: `tt${id}` },
    spoken_languages: [{ iso_639_1: 'sv', english_name: 'Swedish' }],
    production_countries: [{ iso_3166_1: 'FI', name: 'Finland' }],
    content_ratings: { results: [{ iso_3166_1: 'FI', rating: '16' }] },
    'watch/providers': { results: {} },
  };
}

async function seed(page) {
  await guardNetwork(page);
  await page.goto(`${FIXTURE}?seed`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Worker detail library seeded' }),
  ).toBeVisible();
}

async function arrange(page, { tmdb, ratings, warnings, atlas }) {
  const requests = [];
  await page.addInitScript(() => {
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  });
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: artwork }),
  );
  await page.route('**/atlas/**', async (route) => {
    requests.push({
      provider: 'atlas',
      url: route.request().url(),
      headers: route.request().headers(),
    });
    await (atlas ?? ((held) => held.fulfill({ status: 404, json: {} })))(route);
  });
  await page.route('**/metadata/title/query', (route) => {
    requests.push({
      provider: 'atlas',
      url: route.request().url(),
      headers: route.request().headers(),
    });
    return route.fulfill({ json: { entries: [] } });
  });
  for (const [provider, pattern, answer] of [
    ['ratings', '**/ratings/imdb/**', ratings],
    ['warnings', '**/warnings/imdb/**', warnings],
  ])
    await page.route(pattern, async (route) => {
      requests.push({ provider, url: route.request().url(), headers: route.request().headers() });
      await (answer ?? ((held) => held.fulfill({ status: 404, json: { error: 'not_cached' } })))(
        route,
      );
    });
  await routeTmdb(page, async (route) => {
    requests.push({
      provider: 'tmdb',
      url: route.request().url(),
      headers: route.request().headers(),
    });
    const path = new URL(route.request().url()).pathname;
    const external = /\/(?:tv|movie)\/(\d+)\/external_ids$/.exec(path);
    if (external) return route.fulfill({ json: { imdb_id: `tt${external[1]}` } });
    await tmdb(route);
  });
  return requests;
}

function expectWorkerOwned(requests) {
  expect(requests.length).toBeGreaterThan(0);
  const pageOwned = requests.filter(
    ({ headers }) => headers['x-den-test-fetch-realm'] !== undefined,
  );
  expect(pageOwned, `provider requests escaped the Worker: ${JSON.stringify(pageOwned)}`).toEqual(
    [],
  );
}

test('the shared Worker owns normalized title, catalog, detail, extras, identifier and season reads', async ({
  page,
}) => {
  await seed(page);
  const requests = await arrange(page, {
    tmdb: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/external_ids')) return route.fulfill({ json: { imdb_id: 'tt101' } });
      if (path.endsWith('/recommendations'))
        return route.fulfill({
          json: {
            results: [
              {
                id: 303,
                name: 'Worker Recommendation',
                first_air_date: '2023-01-01',
                poster_path: '/recommendation.jpg',
              },
            ],
          },
        });
      if (path.endsWith('/season/1'))
        return route.fulfill({
          json: {
            episodes: [
              {
                episode_number: 1,
                name: 'Worker episode',
                air_date: '2024-01-01',
                runtime: 48,
              },
            ],
          },
        });
      const id = Number(/\/(?:tv|movie)\/(\d+)$/.exec(path)?.[1] ?? 101);
      return route.fulfill({ json: titleBody(id) });
    },
    ratings: async (route) =>
      route.fulfill({
        json: {
          Response: 'True',
          imdbRating: '8.2',
          imdbVotes: '35,000',
          Ratings: [{ Source: 'Rotten Tomatoes', Value: '90%' }],
        },
      }),
    warnings: async (route) =>
      route.fulfill({
        json: {
          id: 101,
          warnings: [
            { id: 1, name: 'Violence warning', category: 'Violence', yes: 4, no: 0 },
            { id: 2, name: 'Body warning', category: 'Body', yes: 8, no: 0 },
          ],
        },
      }),
  });

  await page.goto(`${FIXTURE}?content&type=tv&id=101`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker content ready' })).toBeVisible();
  const result = JSON.parse(await page.locator('[data-content]').innerText());

  expect(result.titles).toMatchObject({
    kind: 'titles',
    titles: [
      { id: 101, title: 'Series 101' },
      { id: 9001, title: 'Series 9001' },
    ],
    retryable: [],
  });
  expect(result.detail).toMatchObject({
    kind: 'title.detail',
    detail: { state: 'ready', value: { title: { id: 101 }, imdbId: 'tt101' } },
  });
  expect(result.catalog).toEqual({
    kind: 'catalog.page',
    titles: [expect.objectContaining({ type: 'tv', id: 303, title: 'Worker Recommendation' })],
  });
  expect(result.externalId).toEqual({
    kind: 'title.external-id',
    imdbId: { state: 'ready', value: 'tt101' },
  });
  expect(result.season).toMatchObject({
    kind: 'season',
    episodes: { state: 'ready', value: [{ number: 1, name: 'Worker episode', runtime: 48 }] },
  });
  expect(result.extras).toMatchObject({
    kind: 'title.extras',
    extras: {
      ratings: { state: 'ready', value: { imdb: 8.2, votes: 35000, rottenTomatoes: 90 } },
      warnings: {
        state: 'ready',
        value: [{ id: 1, label: 'Violence warning', votes: 4 }],
      },
      facts: { state: 'absent' },
      iconicStudios: { state: 'absent' },
    },
  });
  expect(requests.find(({ provider }) => provider === 'ratings').headers['x-api-key']).toBe(
    'worker-detail-omdb',
  );
  expect(requests.find(({ provider }) => provider === 'warnings').headers['x-api-key']).toBe(
    'worker-detail-warnings',
  );
  expect(JSON.stringify(result)).not.toContain('worker-detail-');
  expectWorkerOwned(requests);
});

test('typed search keeps TMDB aggregation inside the shared Worker', async ({ page }) => {
  await seed(page);
  const requests = await arrange(page, {
    tmdb: async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/search/multi'))
        return route.fulfill({
          json: {
            results: [
              {
                id: 707,
                media_type: 'movie',
                title: 'Worker Search Result',
                release_date: '2025-01-01',
                poster_path: '/worker-search.jpg',
                genre_ids: [18],
                vote_average: 8,
                vote_count: 100,
              },
            ],
          },
        });
      return route.fulfill({ json: { results: [] } });
    },
  });

  await page.goto(`${FIXTURE}?search&q=worker`);
  await expect(page.getByRole('link', { name: 'Worker Search Result 2025' })).toBeVisible();
  expectWorkerOwned(requests);
});

test('typed Atlas filter and related reads stay inside the shared Worker', async ({ page }) => {
  await seed(page);
  const requests = await arrange(page, {
    tmdb: (route) => route.fulfill({ json: { results: [] } }),
    atlas: async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/index/filter/movie/titles.json'))
        return route.fulfill({
          json: {
            titles: [
              {
                type: 'movie',
                id: 202,
                title: 'Worker Filter Result',
                posterPath: '/filter.jpg',
              },
            ],
            total: 1,
          },
        });
      if (url.pathname.endsWith('/index/similar/movie/101.json'))
        return route.fulfill({ json: { mixed: [{ type: 'series', id: 303 }] } });
      if (url.pathname.endsWith('/index/row/movie.json'))
        return route.fulfill({
          json: { titles: [{ type: 'movie', id: 404, title: 'Worker Browse Row' }] },
        });
      if (url.pathname.endsWith('/manifest.json'))
        return route.fulfill({
          json: {
            catalogs: [
              {
                type: 'movie',
                id: 'jw-nfx-new',
                name: 'New on Netflix',
                denProviderIds: [8],
              },
            ],
          },
        });
      if (url.pathname.endsWith('/catalog/movie/jw-nfx-new/country=US.json'))
        return route.fulfill({
          json: {
            metas: [{ type: 'movie', moviedb_id: 505, name: 'Worker Service Chart' }],
          },
        });
      if (url.pathname.endsWith('/recommend/home.json'))
        return route.fulfill({ json: { slides: [{ type: 'movie', id: 606 }] } });
      return route.fulfill({ status: 404, json: {} });
    },
  });

  await page.goto(`${FIXTURE}?atlas-content&type=movie&id=101`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker content ready' })).toBeVisible();
  const result = JSON.parse(await page.locator('[data-content]').innerText());

  expect(result.filter).toMatchObject({
    kind: 'atlas.query',
    answer: { state: 'ready', value: { operation: 'titles', titles: [{ id: 202 }] } },
  });
  expect(result.related).toEqual({
    kind: 'atlas.related',
    answer: {
      state: 'ready',
      value: { operation: 'refs', refs: [{ type: 'tv', id: 303 }] },
    },
  });
  expect(result.row).toMatchObject({
    kind: 'atlas.row',
    titles: { state: 'ready', value: [{ id: 404, title: 'Worker Browse Row' }] },
  });
  expect(result.catalogs).toMatchObject({
    kind: 'atlas.service.catalogs',
    catalogs: { state: 'ready', value: [{ id: 'jw-nfx-new', providerIds: [8] }] },
  });
  expect(result.chart).toMatchObject({
    kind: 'atlas.service.chart',
    titles: { state: 'ready', value: [{ id: 505, title: 'Worker Service Chart' }] },
  });
  expect(result.recommendation).toEqual({
    kind: 'atlas.recommend.shared',
    slides: {
      state: 'ready',
      value: [{ type: 'movie', id: 606 }],
    },
  });
  expectWorkerOwned(requests.filter(({ provider }) => provider === 'atlas'));
});

test('a person and their filmography are normalized by the shared Worker', async ({ page }) => {
  await seed(page);
  const requests = await arrange(page, {
    tmdb: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/combined_credits'))
        return route.fulfill({
          json: {
            cast: [
              {
                id: 808,
                media_type: 'movie',
                title: 'Worker Film',
                release_date: '2025-01-01',
                poster_path: '/worker-film.jpg',
              },
            ],
            crew: [],
          },
        });
      return route.fulfill({
        json: {
          id: 7,
          name: 'Worker Person',
          profile_path: '/worker-person.jpg',
          biography: 'A biography supplied through the content Worker.',
          known_for_department: 'Acting',
        },
      });
    },
  });

  await page.goto(`${FIXTURE}?person&id=7`);
  await expect(page.getByRole('heading', { name: 'Worker Person', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Worker Film 2025', exact: true })).toBeVisible();
  expectWorkerOwned(requests);
});

test.describe('Worker-owned detail metadata boundary', () => {
  test('base detail paints before independent extras, and season/extras stay Worker-owned', async ({
    page,
  }) => {
    await seed(page);
    const ratingsGate = deferred();
    const warningsGate = deferred();
    const requests = await arrange(page, {
      tmdb: async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/season/1'))
          return route.fulfill({
            json: {
              episodes: [
                {
                  episode_number: 1,
                  name: 'Worker episode',
                  air_date: '2024-01-01',
                  runtime: 48,
                },
              ],
            },
          });
        return route.fulfill({ json: titleBody(101) });
      },
      ratings: async (route) => {
        await ratingsGate.promise;
        return route.fulfill({
          json: {
            Response: 'True',
            imdbRating: '8.2',
            imdbVotes: '35,000',
            Ratings: [
              { Source: 'Rotten Tomatoes', Value: '90%' },
              { Source: 'Metacritic', Value: '78/100' },
            ],
          },
        });
      },
      warnings: async (route) => {
        await warningsGate.promise;
        return route.fulfill({
          json: {
            id: 101,
            warnings: [
              { id: 1, name: 'Violence warning', category: 'Violence', yes: 4, no: 0 },
              { id: 2, name: 'Body warning', category: 'Body', yes: 8, no: 0 },
            ],
          },
        });
      },
    });

    await page.goto(`${FIXTURE}?type=tv&id=101`);
    await expect(page.getByRole('heading', { level: 1, name: 'Series 101' })).toBeVisible();
    await expect(page.getByText('Description for 101.').first()).toBeVisible();
    await expect(page.getByText('Worker episode')).toBeVisible();
    await expect(page.getByText('IMDb', { exact: true })).toHaveCount(0);

    ratingsGate.resolve();
    warningsGate.resolve();
    await expect(page.getByText('IMDb', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Content warnings: 1')).toBeVisible();
    expect(requests.find(({ provider }) => provider === 'ratings').headers['x-api-key']).toBe(
      'worker-detail-omdb',
    );
    expect(requests.find(({ provider }) => provider === 'warnings').headers['x-api-key']).toBe(
      'worker-detail-warnings',
    );
    expectWorkerOwned(requests);
  });

  test('a held old title neither blocks nor overwrites the newly active route', async ({
    page,
  }) => {
    await seed(page);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const requests = await arrange(page, {
      tmdb: async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.includes('/tv/201') && !path.includes('/season/')) {
          firstStarted.resolve();
          await releaseFirst.promise;
          return route.fulfill({ json: titleBody(201) });
        }
        if (path.endsWith('/season/1')) return route.fulfill({ json: { episodes: [] } });
        return route.fulfill({ json: titleBody(202) });
      },
    });

    await page.goto(`${FIXTURE}?type=tv&id=201`);
    await firstStarted.promise;
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture:navigate', { detail: { type: 'tv', id: 202 } }),
      ),
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Series 202' })).toBeVisible();
    releaseFirst.resolve();
    await expect(page.getByRole('heading', { level: 1, name: 'Series 202' })).toBeVisible();
    await expect(page.getByText('Description for 201.')).toHaveCount(0);
    expectWorkerOwned(requests);
  });

  test('a TMDB 404 is stable and optional provider outages do not fail the next detail', async ({
    page,
  }) => {
    await seed(page);
    let missingAttempts = 0;
    const requests = await arrange(page, {
      tmdb: async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/season/1')) return route.fulfill({ json: { episodes: [] } });
        if (path.includes('/tv/308727')) {
          if (
            new URL(route.request().url()).searchParams
              .get('append_to_response')
              ?.includes('aggregate_credits')
          )
            missingAttempts++;
          return route.fulfill({ status: 404, json: { error: 'not_found' } });
        }
        return route.fulfill({ json: titleBody(308728) });
      },
      ratings: async (route) => route.fulfill({ status: 503, body: 'Provider unavailable' }),
      warnings: async (route) => route.fulfill({ status: 404, json: { error: 'not_cached' } }),
    });

    await page.goto(`${FIXTURE}?type=tv&id=308727`);
    await expect(page.getByText('Couldn’t load this title from TMDB.')).toBeVisible();
    await page.waitForTimeout(1_100);
    expect(missingAttempts).toBe(1);
    expect(requests.filter(({ provider }) => provider !== 'tmdb')).toHaveLength(0);

    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture:navigate', { detail: { type: 'tv', id: 308728 } }),
      ),
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Series 308728' })).toBeVisible();
    await expect(page.getByLabel('TMDB rating 7.5')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(missingAttempts).toBe(1);
    expectWorkerOwned(requests);
  });
});
