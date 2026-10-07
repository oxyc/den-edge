import { expect, test } from '@playwright/test';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

async function routePosterArt(page) {
  await page.route(/^https:\/\/(?:image\.tmdb\.org|images\.metahub\.space)\//, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
}

test('Coming Soon captions stay on one line in a horizontal-only shelf', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosterArt(page);
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html`);

  const row = page.getByRole('region', { name: 'Coming Soon' });
  await expect(row.locator('.card')).toHaveCount(10);
  const caption = row.locator('.caption').first();
  await expect(caption).toHaveText('An Exceptional… · Sep 19');
  expect(
    await caption.evaluate((node) => ({
      fits: node.scrollWidth <= node.clientWidth,
      lines: Math.round(node.scrollHeight / Number.parseFloat(getComputedStyle(node).lineHeight)),
      overflow: getComputedStyle(node).overflow,
      textOverflow: getComputedStyle(node).textOverflow,
      whiteSpace: getComputedStyle(node).whiteSpace,
    })),
  ).toEqual({
    fits: true,
    lines: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });

  const track = row.locator('.track');
  const geometry = await track.evaluate((node) => {
    // Move past the first snap point; a smaller assignment can legitimately snap straight back to zero.
    node.scrollLeft = 250;
    node.scrollTop = 100;
    return {
      overflowX: getComputedStyle(node).overflowX,
      overflowY: getComputedStyle(node).overflowY,
      scrollLeft: node.scrollLeft,
      scrollTop: node.scrollTop,
      scrollable: node.scrollWidth > node.clientWidth,
    };
  });
  expect(geometry).toMatchObject({
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollTop: 0,
    scrollable: true,
  });
  expect(geometry.scrollLeft).toBeGreaterThan(0);
  await page.close();
});

// A shared observer activates art only where both axes are near. A far row has no posters; when the row arrives,
// posters near its horizontal viewport load, and art at the far end remains reachable by scrolling the shelf.
test('a row far below the screen draws its posters only once it comes near', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosterArt(page);
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html`);
  const far = page.getByRole('region', { name: 'Far below' });
  await expect(far.locator('a.card, figure.card')).toHaveCount(10);
  await page.waitForTimeout(300);
  await expect(far.locator('img')).toHaveCount(0);
  await far.scrollIntoViewIfNeeded();
  await expect(far.locator('img').first()).toBeVisible();
  expect(await far.locator('img').count()).toBeLessThan(10);
  await expect(far.locator('img').first()).toHaveAttribute(
    'src',
    'https://image.tmdb.org/t/p/w342/far1.jpg',
  );
  await far.locator('.track').evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(far.locator('img[src$="/far10.jpg"]')).toHaveCount(1);
  await page.close();
});

test('availability waits for its narrower lookahead after poster art starts', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosterArt(page);
  const lookups = [];
  await page.route('**/tmdb/3/movie/*/external_ids', (route) => {
    const id = /\/movie\/(\d+)\//.exec(route.request().url())?.[1];
    lookups.push(Number(id));
    return route.fulfill({ json: { imdb_id: `tt${id.padStart(7, '0')}` } });
  });
  await page.route('**/scout/availability', (route) =>
    route.fulfill({ json: { availability: {} } }),
  );
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html?availability`);
  const far = page.getByRole('region', { name: 'Far below' });

  await far.evaluate((node) => scrollTo(0, node.offsetTop - innerHeight - 800));
  await expect(far.locator('img').first()).toBeAttached();
  await page.waitForTimeout(100);
  expect(lookups, 'the 1250px art window does not admit Scout work').toEqual([]);

  await far.evaluate((node) => scrollTo(0, node.offsetTop - innerHeight - 200));
  await expect.poll(() => lookups.length).toBeGreaterThan(0);
  await page.close();
});

test('a landscape TMDB still selects its smaller responsive candidate', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await guardNetwork(page);
  await routePosterArt(page);
  const requests = [];
  await page.route('https://image.tmdb.org/t/p/*/landscape.jpg', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="169"/>',
    });
  });
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html`);
  const image = page.getByRole('region', { name: 'Continue Watching' }).locator('img');
  await expect(image).toHaveAttribute('srcset', /w300.*300w,.*w500.*500w/);
  await expect(image).toHaveAttribute('sizes', 'clamp(203px, 55.1vw, 275.5px)');
  await expect
    .poll(() =>
      image.evaluate((node) => (node.currentSrc ? new URL(node.currentSrc).pathname : '')),
    )
    .toBe('/t/p/w300/landscape.jpg');
  expect(requests).toEqual(['/t/p/w300/landscape.jpg']);
  await page.close();
});
