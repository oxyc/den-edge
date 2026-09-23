import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const FIXTURE = 'http://127.0.0.1:5198/test/service-page.html';

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
  await expect
    .poll(() => asked.filter((path) => path.includes('/catalog/movie/jw-nfx-new/')).length)
    .toBe(1);
  // The hero's own picture lookups are part of the page's first screen, so they start too.
  await expect.poll(() => asked.filter((path) => /\/movie\/10[123]$/.test(path)).length).toBe(3);
  expect(asked).toContain('/atlas/manifest.json');

  // A second gesture within the window asks for nothing more.
  const before = asked.length;
  await page.mouse.move(0, 0);
  await tile.hover();
  await page.waitForTimeout(300);
  expect(asked.length).toBe(before);
});
