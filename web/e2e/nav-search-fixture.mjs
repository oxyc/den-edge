import { expect } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

export const film = (id, title = `Film ${id}`) => ({
  id,
  title,
  media_type: 'movie',
  release_date: '2026-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1000,
  popularity: 100,
});
export const films = Array.from({ length: 30 }, (_, i) => film(100 + i));
// TMDB's series lists: Explore's default, All, shows them beside the films.
export const show = (id, name = `Series ${id}`) => ({
  id,
  name,
  media_type: 'tv',
  first_air_date: '2025-01-01',
  poster_path: '/poster.jpg',
  genre_ids: [18],
  vote_average: 8,
  vote_count: 1000,
  popularity: 100,
});
export const shows = Array.from({ length: 30 }, (_, i) => show(700 + i));
export const active = (page) => page.locator('[data-route-page][data-active="true"]');
export const input = (page) =>
  page.getByRole('searchbox', { name: 'Search titles, people, moods, languages…' });
// The fixture is a file on the dev server, so its own path is where Home lives: the app reads the path, and
// returning Home returns to the address the document was opened at.
export const FIXTURE = 'http://127.0.0.1:5198/test/nav-search.html';
export const HOME = /\/test\/nav-search\.html$/;
export async function setup(page, { atlasGate, catalogueGate, searchGate } = {}) {
  await guardNetwork(page);
  const queries = [];
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', async (r) => {
    if (!atlasGate) return r.fulfill({ status: 404 });
    await atlasGate;
    return r.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } });
  });
  await page.route('**/atlas/catalog/**', async (r) => {
    await catalogueGate;
    return r.fulfill({ json: { metas: [] } });
  });
  // Once atlas is found it ranks the billboard itself.
  await page.route('**/atlas/recommend', async (r) => {
    await catalogueGate;
    return r.fulfill({ json: { version: 1, slides: [] } });
  });
  // Search and the browse rows ask atlas's indexes.
  await page.route('**/atlas/index/**', (r) =>
    r.fulfill({
      json: r.request().url().includes('suggest') ? { perSeed: [], pooled: [] } : { labels: [] },
    }),
  );
  // atlas's stackable filters aren't deployed: a 404, as live, unless a test serves them.
  await page.route('**/atlas/index/filter/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>',
    }),
  );
  await routeTmdb(page, async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.includes('/search/')) {
      const q = url.searchParams.get('query');
      queries.push(q);
      await searchGate?.(q);
      return r.fulfill({
        json: {
          results: q.startsWith('empty')
            ? []
            : q.startsWith('Slow')
              ? [film(999, 'Slow result')]
              : films,
          total_pages: 1,
        },
      });
    }
    const match = /\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (match)
      return r.fulfill({
        json: {
          ...(match[1] === 'tv' ? show(Number(match[2])) : film(Number(match[2]))),
          overview: 'A movie description.',
          genres: [{ id: 18, name: 'Drama' }],
          credits: { cast: [] },
          recommendations: { results: [] },
        },
      });
    const series = /\/tv(\/|$)/.test(url.pathname);
    return r.fulfill({ json: { results: series ? shows : films, total_pages: 1 } });
  });
  return queries;
}
export async function openSearch(page, width) {
  if (width < 760) await page.getByRole('button', { name: 'Search', exact: true }).click();
  else await input(page).click();
  // Reopening search returns to the search it was left on, so the query rides along in the address.
  await expect(page).toHaveURL(/\/search(\?.*)?$/);
  await expect(input(page)).toBeFocused();
}
