import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/service-page.html`;

/**
 * A service in one country, as TMDB and atlas describe it: Netflix carrying films, and atlas's "New on Netflix"
 * chart, whose first title TMDB has no backdrop for. `chart` decides when that chart answers.
 */
async function serveNetflix(page, { chart = async () => {} } = {}) {
  const asked = [];
  await routeTmdb(page, (route) => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    const path = url.pathname.replace(/^\/(tmdb\/)?3\//, '/');
    if (path.startsWith('/watch/providers/'))
      return route.fulfill({
        json: {
          results:
            path === '/watch/providers/movie'
              ? [
                  {
                    provider_id: 8,
                    provider_name: 'Netflix',
                    logo_path: '/n.jpg',
                    display_priority: 1,
                  },
                ]
              : [],
        },
      });
    if (path.startsWith('/discover/')) return route.fulfill({ json: { results: [] } });
    const id = Number(/^\/movie\/(\d+)$/.exec(path)?.[1]);
    if (id)
      return route.fulfill({
        json: {
          id,
          title: `Film ${id}`,
          overview: `About film ${id}.`,
          // The chart's first title has no picture: the hero must not open on a dark frame for it.
          backdrop_path: id === 101 ? null : `/backdrop-${id}.jpg`,
          poster_path: `/poster-${id}.jpg`,
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="teal"/></svg>',
    }),
  );
  await page.route('**/atlas/manifest.json', (route) => {
    asked.push('/atlas/manifest.json');
    return route.fulfill({
      json: {
        catalogs: [
          { type: 'movie', id: 'jw-nfx-new', name: 'New on Netflix', denProviderIds: [8] },
        ],
      },
    });
  });
  await page.route('**/atlas/catalog/**', async (route) => {
    asked.push(new URL(route.request().url()).pathname);
    await chart();
    return route.fulfill({
      json: {
        metas: [101, 102, 103].map((id) => ({
          type: 'movie',
          moviedb_id: id,
          name: `Film ${id}`,
          posterPath: `/poster-${id}.jpg`,
          releaseInfo: '2026',
        })),
      },
    });
  });
  await page.route('**/metadata/title/query', (route) => route.fulfill({ json: { entries: [] } }));
  return asked;
}

test('the service billboard shows a loading state, then its titles with their picture', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await serveNetflix(page, { chart: () => held });
  await page.goto(`${FIXTURE}?page`);

  const hero = page.locator('.hero');
  await expect(hero.getByRole('heading', { name: 'Netflix' })).toBeVisible();
  const loading = hero.getByRole('status');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveText('Loading featured titles');
  await expect(page.locator('.billboard .slide')).toHaveCount(0);

  release();
  await expect(loading).toHaveCount(0);
  // Film 101 has no backdrop, so the hero opens on the first title that has one.
  await expect(page.locator('.billboard .slide').first()).toHaveAttribute('aria-label', 'Film 102');
  await expect(page.locator('.billboard img.backdrop.lit')).toHaveAttribute(
    'src',
    /backdrop-102\.jpg$/,
  );
});

test('resting on a service tile starts loading its page before the press', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  const asked = await serveNetflix(page);
  await page.goto(FIXTURE);

  const tile = page.getByRole('link', { name: 'Netflix' });
  await expect(tile).toBeVisible();
  await page.waitForTimeout(300);
  expect(asked, 'nothing is fetched for a page nobody has gestured towards').toEqual([]);

  await tile.hover();
  const primedRequests = () => ({
    manifest: asked.filter((path) => path === '/atlas/manifest.json').length,
    directories: asked.filter((path) => path.includes('/watch/providers/')).length,
    chart: asked.filter((path) => path.includes('/catalog/movie/jw-nfx-new/')).length,
    heroPictures: asked.filter((path) => /\/movie\/10[123]$/.test(path)).length,
    firstRows: asked.filter((path) => path === '/tmdb/3/discover/movie').length,
  });
  // The hover primes the complete first screen: the Atlas row, its hero art, and the next two rows. Waiting for that
  // semantic boundary avoids mistaking a request still belonging to this first gesture for work from the next one.
  const complete = { manifest: 1, directories: 2, chart: 1, heroPictures: 3, firstRows: 2 };
  await expect.poll(primedRequests).toEqual(complete);

  // A second gesture within the reuse window asks none of those questions again. A frame lets the pointer event and
  // any fetch it starts become observable without an elapsed-time guess.
  await page.mouse.move(0, 0);
  await tile.hover();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(primedRequests()).toEqual(complete);
});

test('settings re-read with nothing changed leave the page as it is', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  const asked = await serveNetflix(page);
  await page.goto(`${FIXTURE}?page`);

  const cards = page.locator('a[href^="/movie/10"]:not(.billboard *)');
  await expect(cards.first()).toBeVisible();
  // Cards paint before their rows finish hydrating, and rows below go on loading while the browser is idle
  // (`Browse`). Wait until the page has stopped asking, so a late request is not mistaken for settings work.
  let seen = -1;
  await expect
    .poll(
      async () => {
        const quiet = asked.length === seen;
        seen = asked.length;
        await page.waitForTimeout(500);
        return quiet;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const shown = await cards.count();
  await cards.evaluateAll((all) => all.forEach((card) => (card.dataset.kept = '')));
  const before = asked.length;

  await page.evaluate(() => window.reread());
  await page.waitForTimeout(300);
  await expect(page.locator('a[data-kept]')).toHaveCount(shown);
  expect(asked.length, 'nothing is asked again').toBe(before);
});
