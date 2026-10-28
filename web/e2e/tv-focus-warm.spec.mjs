import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

// A TV remote has no hover and no press before the click. Focus resting on a poster is its intent: after a short
// dwell the title's details are fetched, as a pointer resting on a card does in a browser, so the page opens on an
// answer already under way. Focus running along a row under the arrow keys fetches nothing for what it passes.

const ROW = [2001, 2002, 2003, 2004];

test('a poster the remote rests on fetches its details; one it passes does not', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.route('**/atlas/manifest.json', (route) =>
    route.fulfill({
      json: { id: 'com.den.atlas', catalogs: [{ id: 'popular', type: 'movie', name: 'Popular' }] },
    }),
  );
  const named = ROW.map((id) => ({
    type: 'movie',
    id,
    title: `Movie ${id}`,
    posterPath: `/poster-${id}.jpg`,
    year: 2026,
  }));
  await page.route('**/atlas/catalog/**', (route) =>
    route.fulfill({
      json: {
        metas: named.map(({ id, title, posterPath }) => ({
          type: 'movie',
          moviedb_id: id,
          name: title,
          posterPath,
          releaseInfo: '2026',
        })),
      },
    }),
  );
  await page.route('**/atlas/index/**', (route) =>
    route.fulfill({ json: { titles: named, total: named.length } }),
  );
  // The billboard's own title is not one of the row's: its hero reads the same details.
  await page.route('**/atlas/recommend**', (route) =>
    route.fulfill({ json: { version: 1, slides: [{ type: 'movie', id: 1002 }] } }),
  );
  /** Each of the row's titles whose details were asked of TMDB: atlas already named them, so only a warm asks. */
  const detailed = [];
  page.on('request', (request) => {
    const id = Number(new URL(request.url()).pathname.match(/\/movie\/(\d+)$/)?.[1]);
    if (ROW.includes(id)) detailed.push(id);
  });

  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const row = page.getByRole('region', { name: 'Mind-Bending' });
  const card = (id) => row.getByRole('link', { name: new RegExp(`Movie ${id}`) });
  await expect(card(2004)).toBeAttached({ timeout: 30_000 });
  // The page's clock from here on: each card is focused for exactly 100 ms of it, however slowly this machine runs
  // the steps between, so the dwell is measured by the test rather than by the runner's load.
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  await card(2001).focus();
  // Along the row quickly, as a held arrow key does, to rest on the last card.
  const focusedKey = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-tv-focus-key'));
  for (let step = 0; step < 6 && (await focusedKey()) !== 'movie:2004'; step++) {
    await page.keyboard.press('ArrowRight');
    await page.clock.runFor(100);
  }
  await expect(card(2004)).toBeFocused();
  await page.clock.runFor(1_000);
  await expect.poll(() => detailed.includes(2004), { timeout: 5_000 }).toBe(true);
  expect(
    detailed.filter((id) => id !== 2004),
    'a card focus only passed over',
  ).toEqual([]);
});
