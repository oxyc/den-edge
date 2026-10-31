// Episode release dates from atlas (`GET /airing/tv/{id}`, TVmaze's schedule) through the real app, with the clock on
// Saturday 31 Oct 2026. Dexter: Resurrection's S2E1 was on Paramount+ on Friday 30 Oct while TMDB dated it by the
// broadcaster's Sunday slot, 1 Nov. Every answer is a recorded fixture; nothing leaves the browser.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

const ID = 259909;
const IMDB = 'tt33043892';
const AIRING = JSON.parse(
  readFileSync(new URL('../test/fixtures/airing-dexter.json', import.meta.url), 'utf8'),
);
/** Saturday 31 Oct 2026, midday. */
const SATURDAY = new Date(2026, 9, 31, 12);

const series = {
  id: ID,
  name: 'Dexter: Resurrection',
  first_air_date: '2025-07-11',
  status: 'Returning Series',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'Dexter Morgan wakes up from a coma.',
  external_ids: { imdb_id: IMDB },
  vote_average: 8.2,
  vote_count: 400,
  genres: [{ id: 80, name: 'Crime' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 2 },
    { season_number: 2, name: 'Season 2', episode_count: 3 },
  ],
  // TMDB has not counted S2E1 as aired: its date is Sunday's.
  last_episode_to_air: { season_number: 1, episode_number: 2 },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};
const seasons = {
  1: [
    { episode_number: 1, name: 'A Beating Heart', air_date: '2025-07-11' },
    { episode_number: 2, name: 'Camera Shy', air_date: '2025-07-18' },
  ],
  2: [
    { episode_number: 1, name: 'Risky Business', air_date: '2026-11-01' },
    { episode_number: 2, name: 'Young Blood', air_date: '2026-11-08' },
    { episode_number: 3, name: 'Three', air_date: '2026-11-15' },
  ],
};

/** TMDB as recorded for the series, and atlas's manifest and airing answer for it; every other atlas route is 404. */
async function routeSeries(page) {
  const airing = [];
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    const season = path.match(new RegExp(`/tv/${ID}/season/(\\d+)$`));
    if (season)
      return route.fulfill({
        json: {
          episodes: (seasons[season[1]] ?? []).map((e) => ({ ...e, overview: 'An episode.' })),
        },
      });
    if (path.endsWith(`/tv/${ID}/external_ids`)) return route.fulfill({ json: { imdb_id: IMDB } });
    if (path.endsWith(`/tv/${ID}`)) return route.fulfill({ json: series });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.route(`${E2E_ORIGIN}/atlas/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'Atlas', catalogs: [] } });
    if (url.pathname === `/atlas/airing/tv/${ID}`) {
      airing.push(`${route.request().method()} ${url.pathname}${url.search}`);
      return route.fulfill({
        headers: { 'cache-control': 'public, max-age=21600' },
        json: AIRING,
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  return airing;
}

test('a series page dates its episodes by atlas: out on Paramount+, and Returning', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  await routeGuestEdge(page, newEdge());
  const airing = await routeSeries(page);
  await page.addInitScript(() => localStorage.setItem('den.browsing', '1'));
  await page.goto(`${E2E_ORIGIN}/tv/${ID}-dexter-resurrection?season=2`);
  const active = page.locator('[data-route-page][data-active="true"]');
  const episode = (n) => active.locator(`.episode[data-episode="${n}"]`);

  // E2 is TMDB's 8 Nov, atlas's Friday 6 Nov on Paramount+.
  await expect(episode(2).locator('[data-out]')).toHaveText(/^Out Fri, Nov 6 on Paramount\+$/, {
    timeout: 30_000,
  });
  // E1 was out yesterday by atlas's date, though TMDB says tomorrow: no air date, playable like any aired one.
  await expect(episode(1)).toContainText('Risky Business');
  await expect(episode(1).locator('.air-date')).toHaveCount(0);
  await expect(episode(1).locator('.episode-play')).not.toHaveAttribute('aria-disabled', 'true');
  // E3 is dated by atlas too (13 Nov), still a week out.
  await expect(episode(3).locator('[data-out]')).toHaveText(/^Out Fri, Nov 13 on Paramount\+$/);
  await expect(active.locator('[data-series-status]')).toHaveText('Returning');
  // One GET per series, with the IMDb id as TVmaze's lookup hint.
  expect(airing).toContain(`GET /atlas/airing/tv/${ID}?imdb=${IMDB}`);
});

test('without atlas’s answer the page keeps TMDB’s dates', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  await routeGuestEdge(page, newEdge());
  await routeSeries(page);
  await page.route(`${E2E_ORIGIN}/atlas/airing/**`, (route) =>
    route.fulfill({
      status: 404,
      headers: { 'cache-control': 'public, max-age=21600' },
      json: { error: 'not_found' },
    }),
  );
  await page.addInitScript(() => localStorage.setItem('den.browsing', '1'));
  await page.goto(`${E2E_ORIGIN}/tv/${ID}-dexter-resurrection?season=2`);
  const active = page.locator('[data-route-page][data-active="true"]');
  await expect(active.locator('.episode[data-episode="1"] .air-date')).toHaveText(
    'Airs Nov 1, 2026',
    { timeout: 30_000 },
  );
  await expect(active.locator('[data-out]')).toHaveCount(0);
  await expect(active.locator('[data-series-status]')).toHaveCount(0);
});

const HEARTH = `${E2E_ORIGIN}/den/hearthcfg/manifest.json`;

/**
 * A library kept in this browser that has watched season 1, with the combined Den addon installed: its list for
 * S2E1 is empty until a fresh search (`?fresh=1`) finds a release. Every search for S2E1 is kept on the result.
 */
async function followedLibrary(page, { started = false } = {}) {
  const searches = [];
  await routeSeries(page);
  await page.route(`${E2E_ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${E2E_ORIGIN}/routes`, (route) =>
    route.fulfill({ json: { v: 1, addons: { den: [{ url: `${E2E_ORIGIN}/den` }] } } }),
  );
  await page.route(`${E2E_ORIGIN}/den/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/den/hearthcfg/manifest.json')
      return route.fulfill({
        json: { id: 'com.den.hearth', version: '1.0.0', resources: ['stream'] },
      });
    if (url.pathname === '/den/health') return route.fulfill({ json: { status: 'ok' } });
    // The addon plays through den-edge's unified playback, so the billboard offers Play.
    if (url.pathname === '/den/hearthcfg/playback' && route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204 });
    if (decodeURIComponent(url.pathname) === `/den/hearthcfg/stream/series/${IMDB}:2:1.json`) {
      searches.push(url.search);
      const fresh = url.searchParams.get('fresh') === '1';
      return route.fulfill({
        headers: { 'cache-control': 'private, max-age=300' },
        json: {
          streams: fresh
            ? [
                {
                  title: 'Dexter.Resurrection.S02E01.1080p.WEB.mkv',
                  url: `${E2E_ORIGIN}/den/p/ticket`,
                  behaviorHints: { filename: 'Dexter.Resurrection.S02E01.1080p.WEB.mkv' },
                  attributes: { cached: true, resolution: '1080p' },
                },
              ]
            : [],
          den: { v: 1, answerKind: fresh ? 'live' : 'empty', coverage: { sources: [] } },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
  await page.waitForFunction(() => typeof window.denSeed === 'function');
  await page.evaluate(
    ({ install, id, started }) => {
      const at = [Date.now() - 86_400_000, 0, 'aaaaaaaaaaaaaaaa'];
      const progress = (value) => ({
        progress: { value, at, viewing: 0 },
        imported: false,
        plays: {},
        cleared: null,
      });
      const watched = progress(1);
      return window.denSeed([
        ...(started
          ? [
              {
                format: 4,
                kind: 'season',
                title: { type: 'tv', id },
                season: 2,
                seasonReset: null,
                episodes: { 1: progress(0.3) },
              },
            ]
          : []),
        {
          kind: 'set',
          schema: 2,
          name: 'plugins',
          values: { [install]: { value: { bool: true }, at } },
        },
        {
          format: 4,
          kind: 'title',
          title: { type: 'tv', id },
          status: { value: 'watched', at },
          addedAt: Date.now() - 100 * 86_400_000,
        },
        {
          format: 4,
          kind: 'season',
          title: { type: 'tv', id },
          season: 1,
          seasonReset: null,
          episodes: { 1: watched, 2: watched },
        },
      ]);
    },
    { install: HEARTH, id: ID, started },
  );
  return searches;
}

test('a followed series’ new episode leads the billboard and Continue Watching, marked new', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  const searches = await followedLibrary(page);
  await page.goto(`${E2E_ORIGIN}/`);

  // A fresh search, the list only, found S2E1: the billboard's first slide says so, with Play.
  const billboard = page.locator('.billboard');
  await expect(billboard.locator('.slide').first()).toContainText('New episode · S2E1', {
    timeout: 30_000,
  });
  await expect(billboard.locator('.slide').first()).toContainText('Dexter: Resurrection');
  await expect(
    billboard.locator('.slide').first().getByRole('link', { name: 'Play', exact: true }),
  ).toHaveAttribute('href', `/tv/${ID}-dexter-resurrection?play=1`);
  expect(searches).toContain('?fresh=1');

  // Continue Watching leads with it too: the next episode is S2E1, badged New.
  const shelf = page.locator('section, div').filter({
    has: page.getByRole('heading', { name: 'Continue Watching' }),
  });
  const card = shelf.locator('.poster-card, a').filter({ hasText: 'S2 · E1' }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('New');
  // Found once is enough: the episode is not searched for afresh again while Home stays open.
  expect(searches.filter((search) => search === '?fresh=1')).toHaveLength(1);
});

test('a new episode the viewer has started is not new: no slide, no badge, no search', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  const searches = await followedLibrary(page, { started: true });
  await page.goto(`${E2E_ORIGIN}/`);
  // It is simply being watched: Continue Watching resumes it, unbadged.
  const card = page.locator('.poster-card, a').filter({ hasText: 'S2 · E1' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).not.toContainText('New');
  await expect(page.locator('.billboard')).not.toContainText('New episode');
  // Past the moment Home lets Continue Watching land before it searches (`SEARCH_SETTLE_MS`).
  await page.waitForTimeout(3_000);
  expect(searches).not.toContain('?fresh=1');
});
