// A title whose only releases are cinema recordings, opened by a guest: Hearth's availability verdict names the reason,
// the title page says why it won't play well, and Play asks first. Cancel plays nothing; Play anyway asks Hearth's
// playback for the cinema-recording copies (`allowCinema`).
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, GID, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

const TITLE = 1003;
const NOTICE =
  'Camera and telesync copies have poor picture and sound. You can wait for a proper release or play the best one now.';

test('a cinema-only title explains itself and plays only after Play anyway', async ({ page }) => {
  await routeGuestEdge(page, newEdge());
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/external_ids')) return route.fulfill({ json: { imdb_id: 'tt43' } });
    const match = path.match(/\/movie\/(\d+)$/);
    if (!match) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    return route.fulfill({
      json: {
        id: Number(match[1]),
        title: `Movie ${match[1]}`,
        release_date: '2026-11-18',
        overview: 'A movie only in cinemas so far.',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18 }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        external_ids: { imdb_id: 'tt43' },
        imdb_id: 'tt43',
      },
    });
  });
  await page.route(`${ORIGIN}/den/~${GID}/availability`, (route) =>
    route.fulfill({
      json: {
        availability: { tt43: 'unavailable' },
        reasons: { tt43: 'only_cinema_recordings' },
      },
    }),
  );
  const playbacks = [];
  await page.route(`${ORIGIN}/den/~${GID}/playback`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
    playbacks.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });

  await page.goto(`${ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? 'null')?.[0]?.guest),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.goto(`${ORIGIN}/movie/${TITLE}`);
  const active = page.locator('[data-active="true"]');
  await expect(active.getByRole('status').filter({ hasText: NOTICE })).toBeVisible({
    timeout: 30_000,
  });

  const play = active.getByRole('link', { name: 'Play', exact: true });
  await play.click();
  const question = active.getByRole('group', { name: 'Only cinema recordings so far' });
  await expect(question).toBeVisible();
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toBeHidden();
  expect(playbacks).toEqual([]);

  await play.click();
  await question.getByRole('button', { name: 'Play anyway' }).click();
  await expect.poll(() => playbacks.length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(playbacks[0]).toMatchObject({ imdb: 'tt43', allowCinema: true });
});
