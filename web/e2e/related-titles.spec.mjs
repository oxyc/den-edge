import { expect, test } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

test('a title’s rows rebuilt for a late atlas keep the page where the viewer scrolled it', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  let releaseAtlas;
  const atlasGate = new Promise((r) => (releaseAtlas = r));
  // atlas answers only when the test says so, and has nothing for this title: the row goes on as TMDB's.
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
  const row = page.getByRole('region', { name: 'You might also like' });
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

test('other versions sit between the franchise and You might also like, never repeating the franchise', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await page.route('**/atlas-v/index/suggest.json', (r) =>
    r.fulfill({ json: { perSeed: [{ seed: { type: 'movie', id: 1 }, ids: [], mixed: [] }] } }),
  );
  await page.route('**/atlas-v/index/franchise/movie/1.json', (r) =>
    r.fulfill({
      json: {
        franchise: { id: 'seed', name: 'The Seed Saga' },
        members: [
          { type: 'movie', id: 1, title: 'The Seed' },
          { type: 'movie', id: 2, title: 'The Seed Returns', year: 2003 },
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
  // den-edge keeps no shared metadata for these cards, and TMDB has no detail for them: the cards are drawn as sent.
  await page.route('**/metadata/title/query', (r) => r.fulfill({ status: 404, json: {} }));
  await routeTmdb(page, (r) =>
    /\/3\/movie\/\d+$/.test(new URL(r.request().url()).pathname)
      ? r.fulfill({ status: 404, json: {} })
      : r.fulfill({ json: { page: 2, results: [], total_pages: 1 } }),
  );
  await page.goto('http://127.0.0.1:5198/test/related-titles.html?atlas=/atlas-v');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));

  const franchise = page.getByRole('region', { name: 'The Seed Saga' });
  const versions = page.getByRole('region', { name: 'Other versions' });
  const similar = page.getByRole('region', { name: 'You might also like' });
  await expect(franchise.getByRole('link', { name: /^The Seed Returns / })).toBeVisible();
  await expect(versions.getByRole('link', { name: /^The Seed Stage Film / })).toBeVisible();
  await expect(versions.getByRole('link', { name: /^Seed Again / })).toContainText('2019 · Remake');
  await expect(versions.getByRole('link', { name: /^The Seed Returns / })).toHaveCount(0);
  await expect(similar.getByRole('link', { name: /^Similar film 1 / })).toBeVisible();

  const top = async (region) => (await region.boundingBox()).y;
  expect(await top(franchise)).toBeLessThan(await top(versions));
  expect(await top(versions)).toBeLessThan(await top(similar));
  await page.close();
});
