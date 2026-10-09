import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// A title page opened from Search, with the answers that arrive late on a slow connection held back and then
// delivered one at a time — in the order a real visit saw them land. None of them may move the viewer.
//
// Search stays mounted, hidden, under the title opened from it (`Router.svelte` retains visited pages). Before
// this spec, a library sync that brought any row gave Search a new `prefs` object, Search rebuilt its feed for
// the same selection, and its "a new chip starts at the top" effect scrolled the WINDOW — which was showing the
// title. Measured here before the fix: scrollY 675 → 0 on the sync, from `window.scrollTo` in Search.svelte.

const art =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>';
const gate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  return { promise, release };
};
const capability = `m/s/${'late-plan'.padEnd(40, '_')}?s=${'10'.repeat(12)}`;
const planUrl = 'http://reel.invalid/sources/yt1.json?v=2';
const sourcePlan = {
  v: 2,
  expires: 2_000_000_000,
  crop: null,
  sources: [
    {
      kind: 'mp4',
      audio: true,
      width: 1280,
      height: 720,
      delivery: { type: 'reel', capability },
    },
  ],
};
const film = (id) => ({
  id,
  media_type: 'movie',
  title: `Film ${id}`,
  release_date: '2020-01-01',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  vote_average: 7,
  vote_count: 900,
  genre_ids: [18],
});
const TITLE = 339849;
const SLOW = 1005;

async function setup(page) {
  await guardNetwork(page);
  await page.addInitScript(() => {
    // The page the visit starts on: Search, from which the title is then opened.
    history.replaceState(null, '', '/search');
    // Whatever moves the page names itself.
    window.scrolls = [];
    const scrollTo = window.scrollTo;
    window.scrollTo = function (...args) {
      window.scrolls.push(new Error().stack.split('\n')[2]?.trim());
      return scrollTo.apply(this, args);
    };
  });
  const gates = {
    routes: gate(),
    plan: gate(),
    planAsked: gate(),
    planReturned: gate(),
    slow: gate(),
  };
  await page.route('**/routes', async (r) => {
    await gates.routes.promise;
    await r.fulfill({ json: { reel: [{ url: E2E_ORIGIN }] } });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: art }),
  );
  await page.route('**/reel/prepare/**', (r) =>
    r.fulfill({
      json: {
        v: 2,
        meta: { links: [{ planUrl }] },
        primary: { id: 'yt1', planUrl },
        // A degraded prepare makes the cursor fetch this plan lazily. That late plan publication is the
        // trailer answer whose arrival must not move the title page.
        primaryPlan: null,
      },
    }),
  );
  await page.route('**/reel/sources/yt1.json**', async (r) => {
    gates.planAsked.release();
    await gates.plan.promise;
    await r.fulfill({ json: sourcePlan });
    gates.planReturned.release();
  });
  await page.route('**/reel/transport', (r) =>
    r.fulfill({
      json: {
        v: 2,
        capability,
        attempts: [{ type: 'relay', url: `/reel/${capability}` }],
      },
    }),
  );
  await page.route(
    (url) => `${url.pathname}${url.search}` === `/reel/${capability}`,
    (r) => r.fulfill({ status: 404, body: '' }),
  );
  await page.route('**/atlas/**', (r) => r.fulfill({ json: { ids: [] } }));
  await routeTmdb(page, async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/combined_credits'))
      return r.fulfill({
        json: { cast: Array.from({ length: 12 }, (_, i) => film(700 + i)), crew: [] },
      });
    if (path.includes('/person/')) return r.fulfill({ json: { name: 'Someone' } });
    const id = Number(path.match(/\/(?:movie|tv)\/(\d+)$/)?.[1]);
    if (id === TITLE)
      return r.fulfill({
        json: {
          id,
          title: 'The Title',
          release_date: '2020-01-01',
          imdb_id: 'tt339849',
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          overview: 'A film.',
          genres: [{ id: 18, name: 'Drama' }],
          credits: {
            cast: Array.from({ length: 5 }, (_, i) => ({
              id: 10 + i,
              name: `Actor ${i}`,
              profile_path: '/p.jpg',
              character: 'Someone',
            })),
            crew: [],
          },
          recommendations: {
            page: 1,
            total_pages: 1,
            results: Array.from({ length: 20 }, (_, i) => film(1000 + i)),
          },
          videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'yt1', official: true }] },
          release_dates: { results: [] },
        },
      });
    if (id) {
      // One of "More like this"'s titles answers late, which holds the row back.
      if (id === SLOW) await gates.slow.promise;
      return r.fulfill({ json: { ...film(id), credits: { cast: [] } } });
    }
    // Search's grid and everything else that lists titles.
    return r.fulfill({
      json: { page: 1, total_pages: 1, results: Array.from({ length: 20 }, (_, i) => film(i + 1)) },
    });
  });
  return gates;
}

test('late answers leave a title opened from Search where the viewer scrolled it', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const gates = await setup(page);
  await page.goto(`${E2E_ORIGIN}/test/title-scroll.html`);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();

  await page.evaluate(
    (id) =>
      document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: `/movie/${id}` } })),
    TITLE,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'The Title' })).toBeVisible();
  await gates.planAsked.promise;
  // Down toward the rows under the cast.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await page.waitForTimeout(300);
  const y = await page.evaluate(() => scrollY);
  const at = () => page.evaluate(() => ({ y: scrollY, scrolls: window.scrolls.slice() }));
  const before = (await at()).scrolls.length;
  const landed = {};

  // den-edge's routes table, replacing the kept one while the v2 plan is still in flight.
  gates.routes.release();
  await page.waitForTimeout(300);
  landed.routes = (await at()).y;
  // A library sync that brought a row.
  await page.evaluate(() => window.fixtureSync(false));
  await page.waitForTimeout(300);
  landed.sync = (await at()).y;
  // One that changed a setting, as keeping where den-remux answered does.
  await page.evaluate(() => window.fixtureSync(true));
  await page.waitForTimeout(300);
  landed.settings = (await at()).y;
  // Reel's late source-plan answer, consumed through the next two render opportunities.
  gates.plan.release();
  await gates.planReturned.promise;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  landed.trailer = (await at()).y;
  // The last "More like this" title.
  gates.slow.release();
  await page.waitForTimeout(300);
  landed.title = (await at()).y;

  const { scrolls } = await at();
  expect(landed).toEqual({ routes: y, sync: y, settings: y, trailer: y, title: y });
  expect(scrolls.slice(before), 'nothing but the viewer scrolls the page').toEqual([]);

  // Back to Search, and a new pick there still starts at the top of the page.
  await page.evaluate(() => document.dispatchEvent(new Event('den:back')));
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 400));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(400);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('den:navigate', { detail: { path: '/search?type=movie' } }),
    ),
  );
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.close();
});
