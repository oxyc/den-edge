// Follows and the updates list (den-spec follows-v1) through the real app, with the clock on Saturday 31 Oct 2026 and
// atlas's recorded answer for Dexter: Resurrection, whose S2E1 came out on Friday 30 Oct. The library is kept in this
// browser; nothing leaves it.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { airingBatch, routeTmdb } from './network.mjs';

const ID = 259909;
const AIRING = JSON.parse(
  readFileSync(new URL('../test/fixtures/airing-dexter.json', import.meta.url), 'utf8'),
);
/** Saturday 31 Oct 2026, midday. */
const SATURDAY = new Date(2026, 9, 31, 12);
const EVENT = `episode:tv:${ID}:2:1`;

const series = {
  id: ID,
  name: 'Dexter: Resurrection',
  first_air_date: '2025-07-11',
  status: 'Returning Series',
  poster_path: '/poster.jpg',
  overview: 'Dexter Morgan wakes up from a coma.',
  external_ids: { imdb_id: 'tt33043892' },
  vote_average: 8.2,
  vote_count: 400,
  seasons: [{ season_number: 2, name: 'Season 2', episode_count: 3 }],
  last_episode_to_air: { season_number: 2, episode_number: 1 },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};

/** A library kept in this browser holding `rows`, with TMDB and atlas answering for the series. */
async function library(page, rows) {
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/tv/${ID}`)) return route.fulfill({ json: series });
    if (path.endsWith(`/tv/${ID}/season/2`)) return route.fulfill({ json: { episodes: [] } });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.route(`${E2E_ORIGIN}/atlas/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/atlas/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'Atlas', catalogs: [] } });
    if (url.pathname === '/atlas/airing' && route.request().method() === 'POST')
      return route.fulfill({
        json: airingBatch(route.request(), (tmdb) => (tmdb === ID ? AIRING : null)),
      });
    if (url.pathname === `/atlas/airing/tv/${ID}`)
      return route.fulfill({ headers: { 'cache-control': 'public, max-age=21600' }, json: AIRING });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.route(`${E2E_ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${E2E_ORIGIN}/routes`, (route) => route.fulfill({ json: { v: 1 } }));
  await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
  await page.waitForFunction(() => typeof window.denSeed === 'function');
  await page.evaluate((seed) => window.denSeed(seed), rows);
}

const follows = (since) => ({
  kind: 'set',
  schema: 2,
  name: 'follows',
  values: { [`tv:${ID}`]: { value: { int: since }, at: [since, 0, 'aaaaaaaaaaaaaaaa'] } },
});

test('an episode out after the follow is listed, and marking it read clears the count for good', async ({
  page,
}) => {
  await page.clock.setFixedTime(SATURDAY);
  await library(page, [follows(new Date(2026, 9, 20, 12).getTime())]);
  await page.goto(`${E2E_ORIGIN}/updates`);
  const update = page.locator(`[data-update="${EVENT}"]`);
  await expect(update).toContainText('S2E1 · aired', { timeout: 30_000 });
  await expect(page.locator('nav a[href="/updates"] .count')).toContainText('1');

  await update.getByRole('button', { name: 'Mark as read' }).click();
  await expect(page.locator('nav a[href="/updates"] .count')).toHaveCount(0);
  await expect(update.getByRole('button', { name: 'Mark as read' })).toHaveCount(0);

  // The mark is in the profile's library, not in this page: a reload derives the event again, already read.
  await page.reload();
  await expect(page.locator(`[data-update="${EVENT}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(`[data-update="${EVENT}"]`).getByRole('button', { name: 'Mark as read' }),
  ).toHaveCount(0);
  await expect(page.locator('nav a[href="/updates"] .count')).toHaveCount(0);
});

test('a follow made today is a baseline: what already aired is not listed', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  await library(page, [follows(SATURDAY.getTime())]);
  await page.goto(`${E2E_ORIGIN}/updates`);
  await expect(page.getByText('Nothing new from what you follow yet.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(`[data-update="${EVENT}"]`)).toHaveCount(0);
});

test('Follow on a series page follows it, apart from the Watchlist', async ({ page }) => {
  await page.clock.setFixedTime(SATURDAY);
  await library(page, []);
  await page.goto(`${E2E_ORIGIN}/tv/${ID}-dexter-resurrection`);
  const active = page.locator('[data-route-page][data-active="true"]');
  const follow = active.getByRole('button', { name: 'Follow' });
  await expect(follow).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await expect(active.getByRole('button', { name: 'Watchlist' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.goto(`${E2E_ORIGIN}/updates`);
  // Followed today: S2E1 came out yesterday, so it is history.
  await expect(page.getByText('Nothing new from what you follow yet.')).toBeVisible({
    timeout: 30_000,
  });
});
