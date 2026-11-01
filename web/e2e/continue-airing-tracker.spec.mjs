// Followed series on Home as they stood at 03:00 UTC on Sunday 1 Nov 2026 (midnight where the viewer is, UTC-3):
// Tracker (TMDB tv 211288) has four episodes of season 4 out and S4E5 due that evening on CBS; Dexter: Resurrection's
// S2E2 is due Friday 6 Nov on Paramount+. TMDB's and atlas's answers are the live ones, recorded.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { assistantRows } from './big-library.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

test.use({ timezoneId: 'America/Sao_Paulo' });

const NOW = new Date('2026-11-01T03:00:00Z');
const TRACKER = 211288;
const DEXTER = 259909;
const COUNTS = { 1: 13, 2: 20, 3: 22, 4: 7 };

const tracker = {
  id: TRACKER,
  name: 'Tracker',
  first_air_date: '2024-02-11',
  status: 'Returning Series',
  poster_path: '/tracker.jpg',
  backdrop_path: '/tracker-backdrop.jpg',
  overview: 'A survivalist and reward seeker helps law enforcement find missing people.',
  external_ids: { imdb_id: 'tt20240254' },
  vote_average: 7.9,
  vote_count: 600,
  genres: [{ id: 80, name: 'Crime' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 13, air_date: '2024-02-11' },
    { season_number: 2, name: 'Season 2', episode_count: 20, air_date: '2024-10-13' },
    { season_number: 3, name: 'Season 3', episode_count: 22, air_date: '2025-10-19' },
    { season_number: 4, name: 'Season 4', episode_count: 7, air_date: '2026-10-04' },
  ],
  last_episode_to_air: { season_number: 4, episode_number: 4, air_date: '2026-10-25' },
  next_episode_to_air: { season_number: 4, episode_number: 5, air_date: '2026-11-01' },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};
const dexter = {
  id: DEXTER,
  name: 'Dexter: Resurrection',
  first_air_date: '2025-07-11',
  status: 'Returning Series',
  poster_path: '/dexter.jpg',
  external_ids: { imdb_id: 'tt33043892' },
  vote_average: 8.2,
  vote_count: 400,
  genres: [{ id: 80, name: 'Crime' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 10 },
    { season_number: 2, name: 'Season 2', episode_count: 10 },
  ],
  last_episode_to_air: { season_number: 2, episode_number: 1, air_date: '2026-10-30' },
  next_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2026-11-06' },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};
/** den-atlas's live answers (`GET /airing/tv/{id}`). Tracker's S4E5 stays `next` on its own release day. */
const AIRING = {
  [TRACKER]: {
    next: {
      date: '2026-11-01',
      episode: 5,
      name: 'Need to Know',
      season: 4,
      time: '21:30',
      zone: 'America/New_York',
    },
    previous: {
      date: '2026-10-25',
      episode: 4,
      name: 'Purification',
      season: 4,
      time: '21:00',
      zone: 'America/New_York',
    },
    seasonPremiere: { date: '2026-10-04', season: 4 },
    service: 'CBS',
    source: 'tvmaze',
    status: 'running',
    upcoming: [
      { date: '2026-11-01', episode: 5, season: 4, time: '21:30', zone: 'America/New_York' },
      { date: '2026-11-15', episode: 6, season: 4, time: '21:00', zone: 'America/New_York' },
    ],
  },
  [DEXTER]: JSON.parse(
    readFileSync(new URL('../test/fixtures/airing-dexter.json', import.meta.url), 'utf8'),
  ),
};
/** The first of the series the library has watched an episode of besides these two (`seed`). */
const OTHER = 900001;

/** TMDB and atlas as recorded for Tracker and Dexter; every other series is a named one atlas does not know. */
async function routeSeries(page, { airingDelayMs = 0 } = {}) {
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    const season = path.match(/\/tv\/(\d+)\/season\/(\d+)$/);
    if (season)
      return route.fulfill({
        json: {
          season_number: Number(season[2]),
          episodes: Array.from({ length: COUNTS[season[2]] ?? 8 }, (_, i) => ({
            episode_number: i + 1,
            name: `Episode ${i + 1}`,
            overview: 'An episode.',
          })),
        },
      });
    if (path.endsWith(`/tv/${TRACKER}`)) return route.fulfill({ json: tracker });
    if (path.endsWith(`/tv/${DEXTER}`)) return route.fulfill({ json: dexter });
    const other = path.match(/\/tv\/(9\d{5})$/);
    if (other)
      return route.fulfill({
        json: {
          id: Number(other[1]),
          name: `Series ${other[1]}`,
          first_air_date: '2020-01-01',
          status: 'Ended',
          poster_path: `/p${other[1]}.jpg`,
          vote_average: 7,
          vote_count: 100,
          seasons: [{ season_number: 1, name: 'Season 1', episode_count: 8 }],
          last_episode_to_air: { season_number: 1, episode_number: 8 },
          aggregate_credits: { cast: [] },
          recommendations: { results: [] },
        },
      });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.route(`${E2E_ORIGIN}/atlas/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'Atlas', catalogs: [] } });
    const series = url.pathname.match(/^\/atlas\/airing\/tv\/(\d+)$/)?.[1];
    if (series && AIRING[series]) {
      if (airingDelayMs) await new Promise((resolve) => setTimeout(resolve, airingDelayMs));
      return route.fulfill({
        headers: { 'cache-control': 'public, max-age=3600' },
        json: AIRING[series],
      });
    }
    return route.fulfill({
      status: 404,
      headers: { 'cache-control': 'public, max-age=3600' },
      json: { error: 'not_found' },
    });
  });
  await page.route(`${E2E_ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
}

/**
 * A library kept in this browser: Tracker watched to the end of season 3 (the finale on 20 May), Dexter: Resurrection
 * to its S2E1 (yesterday), `others` series part way into their first episode since, and `extra` rows besides.
 */
async function seed(page, { others = 0, extra = [] } = {}) {
  await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
  await page.waitForFunction(() => typeof window.denSeed === 'function');
  await page.evaluate(
    ({ tracker, dexter, counts, others, first, extra }) => {
      const mark = (value, at) => ({
        progress: { value, at: [at, 0, 'aaaaaaaaaaaaaaaa'], viewing: 0 },
        imported: false,
        plays: {},
        cleared: null,
      });
      const season = (id, number, episodes) => ({
        format: 4,
        kind: 'season',
        title: { type: 'tv', id },
        season: number,
        seasonReset: null,
        episodes,
      });
      const day = 86_400_000;
      // `n` episodes watched a day apart, the last at `last`.
      const watched = (n, last) =>
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [i + 1, mark(1, last - (n - 1 - i) * day)]),
        );
      const finale = Date.parse('2026-05-20T02:00:00Z');
      const yesterday = Date.parse('2026-10-31T02:00:00Z');
      const title = (id, at) => ({
        format: 4,
        kind: 'title',
        title: { type: 'tv', id },
        status: { value: 'watched', at: [at, 0, 'aaaaaaaaaaaaaaaa'] },
        addedAt: at - 400 * day,
      });
      return window.denSeed([
        ...extra,
        title(tracker, finale),
        season(tracker, 1, watched(counts[1], finale - 60 * day)),
        season(tracker, 2, watched(counts[2], finale - 30 * day)),
        season(tracker, 3, watched(counts[3], finale)),
        title(dexter, yesterday),
        season(dexter, 1, watched(10, yesterday - 30 * day)),
        season(dexter, 2, { 1: mark(1, yesterday) }),
        ...Array.from({ length: others }, (_, i) =>
          season(first + i, 1, { 1: mark(0.5, Date.parse('2026-10-20T02:00:00Z') + i * 60_000) }),
        ),
      ]);
    },
    { tracker: TRACKER, dexter: DEXTER, counts: COUNTS, others, first: OTHER, extra },
  );
}

/** Resolves once the page's library Worker hands its library to the whole log for an assistant publish. */
function promotedForPublish(page) {
  return new Promise((resolve) => {
    const hear = (message) => {
      if (message.text().includes('library promoted (task:assistant.publish)')) resolve();
    };
    page.on('console', hear);
    page.on('worker', (worker) => worker.on?.('console', hear));
  });
}

test('a series caught up to its last season stays in Continue Watching after the library is promoted', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.clock.install({ time: NOW });
  await page.setViewportSize({ width: 1000, height: 900 });
  await routeGuestEdge(page, newEdge({ profiles: true }));
  // Atlas answers after the shelf has named its series, as a cold round trip does.
  await routeSeries(page, { airingDelayMs: 4_000 });
  // The household has an assistant connected, whose publishes run on the whole log.
  await seed(page, { others: 4, extra: (await assistantRows(NOW.getTime())).rows });
  await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect(page.getByRole('button', { name: 'Switch profile, current Owner' })).toBeVisible({
    timeout: 30_000,
  });
  const promoted = promotedForPublish(page);
  await page.goto(`${E2E_ORIGIN}/`);

  const shelf = page.getByRole('region', { name: 'Continue Watching' });
  const card = shelf.locator(`a[href^="/tv/${TRACKER}-tracker"]`).first();
  await promoted;
  // Season 4 is out: the next episode is S4E1, after the whole log has taken over and after Home's airing tick.
  await expect(card).toContainText('S4 · E1', { timeout: 15_000 });
  await page.clock.fastForward(5 * 60_000 + 1_000);
  await page.waitForTimeout(3_000);
  await expect(card).toContainText('S4 · E1');
});

test('Home lists the followed series’ episodes this week for a library following hundreds of series', async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  await routeSeries(page);
  // More followed series than one request to the content worker may name (its wire's 512 titles).
  await seed(page, { others: 520 });
  await page.goto(`${E2E_ORIGIN}/`);

  const week = page.getByRole('region', { name: 'This week' });
  // Tracker's S4E5 is out this evening: today's episode is this week's, as the Apple apps list it.
  await expect(week.locator(`a[href*="/tv/${TRACKER}-tracker"]`)).toContainText('S4 · E5', {
    timeout: 60_000,
  });
  await expect(week.locator(`a[href*="/tv/${DEXTER}-dexter-resurrection"]`)).toContainText(
    'S2 · E2 · Fri, Nov 6',
  );
});
