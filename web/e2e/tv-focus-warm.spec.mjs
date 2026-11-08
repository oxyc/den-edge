import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

// A TV remote has no hover and no press before the click. Focus resting on a poster is its intent: after a short
// dwell the title's details are fetched, as a pointer resting on a card does in a browser, so the page opens on an
// answer already under way. Focus running along a row under the arrow keys fetches nothing for what it passes.

const ROW = [2001, 2002, 2003, 2004];

/** A guest's Home whose atlas rows list the four titles of `ROW`. */
async function routeHome(page) {
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
}

test('a poster the remote rests on fetches its details; one it passes does not', async ({
  page,
}) => {
  await routeHome(page);
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
  // The row fills its cards a couple per animation frame once it nears the screen, and the paused clock below also
  // pauses those frames. Bring it on screen and let it fill first: a remote cannot move onto a card not yet there.
  await row.evaluate((region) => region.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(row.locator('a.proxy')).toHaveCount(0, { timeout: 30_000 });
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

// A card not yet mounted is a light proxy link. Focusing one mounts its card and moves focus onto it a render later.
// A press handled before that render (a busy TV can land the next one first) has moved on, and keeps its place.
test('a remote press made before a focused placeholder becomes its card keeps its place', async ({
  page,
}) => {
  await routeHome(page);
  await page.goto(E2E_ORIGIN);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  // The row is still placeholders until it nears the screen.
  const placeholder = page
    .getByRole('region', { name: 'Mind-Bending' })
    .locator('a.proxy[aria-label="Movie 2001"]');
  await expect(placeholder).toBeAttached({ timeout: 30_000 });
  const home = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', {
    name: 'Home',
  });

  // Focus lands on the placeholder, and the next press moves on before its card has rendered.
  await placeholder.evaluate((proxy) => {
    proxy.focus();
    document.querySelector('nav[aria-label="Main navigation"] a[href="/"]').focus();
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(home).toBeFocused();
});
