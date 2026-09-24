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
  await page.route('**/atlas-late/index/similar/movie/1.json', async (r) => {
    await atlasGate;
    await r.fulfill({ json: { ids: [] } });
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
