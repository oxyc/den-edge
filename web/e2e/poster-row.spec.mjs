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
  const page = await browser.newPage({ viewport: { width: 1920, height: 800 } });
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
  const trackBox = await track.boundingBox();
  expect(trackBox).not.toBeNull();
  expect(Math.abs(trackBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(trackBox.width - page.viewportSize().width)).toBeLessThanOrEqual(1);
  const [headingBox, firstCardBox] = await Promise.all([
    row.getByRole('heading', { name: 'Coming Soon' }).boundingBox(),
    row.locator('.card').first().boundingBox(),
  ]);
  expect(headingBox).not.toBeNull();
  expect(firstCardBox).not.toBeNull();
  expect(Math.abs(firstCardBox.x - headingBox.x)).toBeLessThanOrEqual(1);
  const geometry = await track.evaluate((node) => {
    // Move past the first snap point; a smaller assignment can legitimately snap straight back to zero.
    node.scrollLeft = 250;
    node.scrollTop = 100;
    return {
      overflowX: getComputedStyle(node).overflowX,
      overflowY: getComputedStyle(node).overflowY,
      overflowAnchor: getComputedStyle(node).overflowAnchor,
      paddingLeft: getComputedStyle(node).paddingLeft,
      paddingRight: getComputedStyle(node).paddingRight,
      scrollLeft: node.scrollLeft,
      scrollTop: node.scrollTop,
      scrollable: node.scrollWidth > node.clientWidth,
    };
  });
  expect(geometry).toMatchObject({
    overflowX: 'auto',
    overflowY: 'hidden',
    overflowAnchor: 'none',
    paddingRight: '0px',
    scrollTop: 0,
    scrollable: true,
  });
  expect(Number.parseFloat(geometry.paddingLeft)).toBeGreaterThan(0);
  expect(geometry.scrollLeft).toBeGreaterThan(0);
  await page.close();
});

test('an ultrawide window keeps shelves on the centred 1920px presentation canvas', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 2560, height: 900 } });
  await guardNetwork(page);
  await routePosterArt(page);
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html`);

  const row = page.getByRole('region', { name: 'Coming Soon' });
  const [rowBox, trackBox, headingBox, firstCardBox] = await Promise.all([
    row.boundingBox(),
    row.locator('.track').boundingBox(),
    row.getByRole('heading', { name: 'Coming Soon' }).boundingBox(),
    row.locator('.card').first().boundingBox(),
  ]);
  expect(rowBox).not.toBeNull();
  expect(trackBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(firstCardBox).not.toBeNull();
  expect(rowBox).toMatchObject({ x: 320, width: 1920 });
  expect(trackBox).toMatchObject({ x: 320, width: 1920 });
  expect(Math.abs(firstCardBox.x - headingBox.x)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(2560);
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
  const pageOwned = [];
  await page.addInitScript(() => {
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  });
  await page.route('**/tmdb/3/movie/*/external_ids', (route) => {
    const id = /\/movie\/(\d+)\//.exec(route.request().url())?.[1];
    lookups.push(Number(id));
    if (route.request().headers()['x-den-test-fetch-realm']) pageOwned.push(Number(id));
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
  expect(pageOwned, 'IMDb identifier resolution stays in the content Worker').toEqual([]);
  await page.close();
});

// A profile page opens more than one session, and each new one's first configure has no scout yet. Its arrival must
// not throw away what scout already answered (or the answer on its way): scrolling back over the shelf afterwards
// asks scout about nothing it has answered.
test('scrolling back over a shelf asks scout nothing it answered, though another session opened', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosterArt(page);
  await page.route('**/tmdb/3/movie/*/external_ids', (route) => {
    const id = /\/movie\/(\d+)\//.exec(route.request().url())?.[1];
    return route.fulfill({ json: { id: Number(id), imdb_id: `tt${id.padStart(7, '0')}` } });
  });
  const asked = [];
  let releaseFirst;
  const firstHeld = new Promise((resolve) => (releaseFirst = resolve));
  let firstAsked;
  const firstArrived = new Promise((resolve) => (firstAsked = resolve));
  await page.route('**/scout/availability', async (route) => {
    const ids = route.request().postDataJSON().ids;
    const first = asked.length === 0;
    asked.push(...ids);
    if (first) {
      firstAsked();
      await firstHeld;
    }
    return route.fulfill({
      json: {
        availability: Object.fromEntries(
          ids.map((id) => [id, id === 'tt0000100' ? 'unavailable' : 'available']),
        ),
      },
    });
  });
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html?availability`);
  const far = page.getByRole('region', { name: 'Far below' });
  await far.scrollIntoViewIfNeeded();
  await firstArrived;

  // Another session opens while scout's first answer is still on its way.
  await page.evaluate(() => window.fixtureOpenSession());
  releaseFirst();
  await expect(far.locator('.card.faded')).toHaveCount(1);

  // Along the shelf and back, then away down the page and back.
  const track = far.locator('.track');
  for (const left of ['end', 0, 'end', 0])
    await track.evaluate((node, to) => {
      node.scrollLeft = to === 'end' ? node.scrollWidth : to;
      node.dispatchEvent(new Event('scroll'));
    }, left);
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
  await far.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_500);

  const twice = asked.filter((id, index) => asked.indexOf(id) !== index);
  expect(twice, 'no movie scout answered is asked again').toEqual([]);
  expect(asked.length).toBeGreaterThan(0);
  await expect(far.locator('.card.faded')).toHaveCount(1);
  await page.close();
});

// Familjen Andersson (TMDB tv 233351, IMDb tt28784095) gets an empty stream list from every source. Its poster asks
// scout's list for S1E1 — the list only, never a play link — and fades; a series scout lists sources for does not.
test('a series with nothing to play fades, from one stream-list search of the episode it asks about', async ({
  browser,
}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guardNetwork(page);
  await routePosterArt(page);
  await page.route('**/tmdb/3/movie/*/external_ids', (route) => {
    const id = /\/movie\/(\d+)\//.exec(route.request().url())?.[1];
    return route.fulfill({ json: { id: Number(id), imdb_id: `tt${id.padStart(7, '0')}` } });
  });
  await page.route('**/tmdb/3/tv/*/external_ids', (route) => {
    const id = Number(/\/tv\/(\d+)\//.exec(route.request().url())?.[1]);
    return route.fulfill({
      json: { id, imdb_id: id === 233351 ? 'tt28784095' : id === 1399 ? 'tt0944947' : null },
    });
  });
  await page.route('**/scout/availability', (route) =>
    route.fulfill({ json: { availability: {} } }),
  );
  const lists = [];
  await page.route('**/scout/stream/**', (route) => {
    const url = new URL(route.request().url());
    lists.push(decodeURIComponent(url.pathname));
    return route.fulfill({
      json: url.pathname.includes('tt0944947')
        ? { streams: [{ url: '/scout/p/ticket', title: 'Winter.Is.Coming.1080p.mkv' }] }
        : { streams: [], den: { answerKind: 'empty', coverage: { sources: [] } } },
    });
  });
  await page.goto(`${E2E_ORIGIN}/test/poster-row.html?availability`);

  const row = page.getByRole('region', { name: 'Series' });
  const card = (name) => row.locator('.card').filter({ hasText: name });
  await expect(card('Familjen Andersson')).toHaveClass(/\bfaded\b/);
  await expect(card('Playable series')).not.toHaveClass(/\bfaded\b/);
  expect(lists.sort()).toEqual([
    '/scout/stream/series/tt0944947:1:1.json',
    '/scout/stream/series/tt28784095:1:1.json',
  ]);
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
