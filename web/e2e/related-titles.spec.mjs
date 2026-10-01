import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

const art = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>';
const routePosters = (page) =>
  page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: art }),
  );

test('a title’s rows below the fold load only as they near the screen', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosters(page);
  let asked = 0;
  await routeTmdb(page, (r) => {
    asked++;
    return r.fulfill({ json: { page: 2, results: [], total_pages: 1 } });
  });
  await page.goto('http://127.0.0.1:5198/test/related-titles.html');
  const row = page.getByRole('region', { name: 'More like this' });
  await expect(row).toBeAttached();
  // Well past the browser's next idle moment, which is when every row used to ask for its first page.
  await page.waitForTimeout(1500);
  await expect(row.locator('a.card')).toHaveCount(0);
  expect(asked).toBe(0);
  await row.scrollIntoViewIfNeeded();
  await expect(row.getByRole('link', { name: /^Similar film 1 / })).toBeVisible();
  await page.close();
});

test('a title’s rows rebuilt for a late atlas keep the page where the viewer scrolled it', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosters(page);
  let releaseAtlas;
  const atlasGate = new Promise((r) => (releaseAtlas = r));
  // atlas answers only when the test says so, and has nothing for this title: the row goes on as TMDB's.
  await page.route('**/atlas-late/index/similar/movie/1.json*', async (r) => {
    await atlasGate;
    await r.fulfill({ json: { ids: [], mixed: [] } });
  });
  await page.route('**/atlas-late/index/franchise/**', (r) => r.fulfill({ json: {} }));
  await page.route('**/atlas-late/index/suggest.json', async (r) => {
    await atlasGate;
    await r.fulfill({
      json: {
        perSeed: [{ seed: { type: 'movie', id: 1 }, ids: [], mixed: [] }],
        pooled: [],
        pooledMixed: [],
      },
    });
  });
  // The title's own first page of recommendations is all TMDB has.
  await routeTmdb(page, (r) => r.fulfill({ json: { page: 2, results: [], total_pages: 1 } }));
  await page.goto('http://127.0.0.1:5198/test/related-titles.html');

  // The rows load as they near the screen, so go to them first.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const row = page.getByRole('region', { name: 'More like this' });
  await expect(row.getByRole('link', { name: /^Similar film 1 / })).toBeVisible();
  // At the foot of the page, where rows that vanish for a moment would pull the viewer up by their height.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const bottom = await page.evaluate(() => scrollY);
  expect(bottom).toBeGreaterThan(1000);

  await page.evaluate(() => window.setAtlas('/atlas-late'));
  // While atlas is slow the rows already shown stay, and so does the viewer.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => scrollY)).toBe(bottom);
  await expect(row.getByRole('link', { name: /^Similar film 1 / })).toBeVisible();

  releaseAtlas();
  await expect(row.getByRole('link', { name: /^Similar film 1 / })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => scrollY)).toBe(bottom);
  await page.close();
});

test('other versions sit between the franchise and More like this, never repeating the franchise', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosters(page);
  await page.route('**/atlas-v/index/similar/**', (r) =>
    r.fulfill({ json: { ids: [], mixed: [] } }),
  );
  await page.route('**/atlas-v/index/suggest.json', (r) =>
    r.fulfill({ json: { perSeed: [{ seed: { type: 'movie', id: 1 }, ids: [], mixed: [] }] } }),
  );
  await page.route('**/atlas-v/index/franchise/movie/1.json', (r) =>
    r.fulfill({
      json: {
        franchise: { id: 'seed', name: 'The Seed Saga' },
        // Atlas's cards carry no posters, and its order (the seed's era first) is neither id nor year order.
        members: [
          { type: 'movie', id: 1, title: 'The Seed', posterPath: null },
          { type: 'movie', id: 3, title: 'The Seed Reborn', year: 2010, posterPath: null },
          { type: 'movie', id: 2, title: 'The Seed Returns', year: 2003, posterPath: null },
        ],
      },
    }),
  );
  await page.route('**/atlas-v/index/versions/movie/1.json', (r) =>
    r.fulfill({
      json: {
        seed: { type: 'movie', id: 1 },
        versions: [
          { type: 'movie', id: 2, title: 'The Seed Returns', year: 2003, kind: 'source' },
          { type: 'movie', id: 40, title: 'The Seed Stage Film', year: 1962, kind: 'source' },
          { type: 'movie', id: 41, title: 'Seed Again', year: 2019, kind: 'remake' },
        ],
        total: 3,
      },
    }),
  );
  // den-edge keeps no shared metadata for these cards, so each is drawn from TMDB's detail, poster and all.
  await page.route('**/metadata/title/query', (r) => r.fulfill({ status: 404, json: {} }));
  const titles = {
    2: 'The Seed Returns',
    3: 'The Seed Reborn',
    40: 'The Seed Stage Film',
    41: 'Seed Again',
  };
  const years = { 2: 2003, 3: 2010, 40: 1962, 41: 2019 };
  await routeTmdb(page, (r) => {
    const id = /\/3\/movie\/(\d+)$/.exec(new URL(r.request().url()).pathname)?.[1];
    if (!id) return r.fulfill({ json: { page: 2, results: [], total_pages: 1 } });
    if (!titles[id]) return r.fulfill({ status: 404, json: {} });
    return r.fulfill({
      json: {
        id: Number(id),
        title: titles[id],
        release_date: `${years[id]}-01-01`,
        poster_path: `/p${id}.jpg`,
      },
    });
  });
  await page.goto('http://127.0.0.1:5198/test/related-titles.html?atlas=/atlas-v');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));

  const franchise = page.getByRole('region', { name: 'The Seed Saga' });
  const versions = page.getByRole('region', { name: 'Other versions' });
  const similar = page.getByRole('region', { name: 'More like this' });
  // Poster-less atlas cards are drawn and shown, in atlas's order rather than by year.
  const reborn = franchise.getByRole('link', { name: /^The Seed Reborn / });
  const returns = franchise.getByRole('link', { name: /^The Seed Returns / });
  await expect(returns).toBeVisible();
  await expect(franchise.getByRole('link')).toHaveCount(2);
  expect((await reborn.boundingBox()).x).toBeLessThan((await returns.boundingBox()).x);
  await expect(versions.getByRole('link', { name: /^The Seed Stage Film / })).toBeVisible();
  await expect(versions.getByRole('link', { name: /^Seed Again / })).toContainText('2019 · Remake');
  await expect(versions.getByRole('link', { name: /^The Seed Returns / })).toHaveCount(0);
  await expect(similar.getByRole('link', { name: /^Similar film 1 / })).toBeVisible();

  const top = async (region) => (await region.boundingBox()).y;
  expect(await top(franchise)).toBeLessThan(await top(versions));
  expect(await top(versions)).toBeLessThan(await top(similar));
  await page.close();
});
