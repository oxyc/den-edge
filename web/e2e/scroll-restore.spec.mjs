import { test, expect, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// Back lands where the page was left: the window's scroll and every row's own horizontal scroll, on any page.
// Mobile viewport and touch, in Chromium and WebKit, because WebKit leaves a retained page's rows stale.

const art =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="281"><rect width="500" height="281" fill="#264c68"/></svg>';
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

async function setup(page, start) {
  await guardNetwork(page);
  await page.addInitScript((path) => history.replaceState(null, '', path), start);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: art }),
  );
  await page.route('**/atlas/**', (r) => r.fulfill({ json: { ids: [] } }));
  await page.route('**/atlas/manifest.json', (r) => r.fulfill({ json: { id: 'com.den.atlas' } }));
  // A title's facts and studios are asked for again each time its page returns, and answer after the page is back.
  const asked = new Set();
  await page.route(/\/atlas\/index\/(title|studios)\//, async (r) => {
    const url = r.request().url();
    if (asked.has(url)) await new Promise((resolve) => setTimeout(resolve, 500));
    asked.add(url);
    await r.fulfill({ json: {} });
  });
  await routeTmdb(page, async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith('/combined_credits')) return r.fulfill({ json: { cast: [], crew: [] } });
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
          credits: { cast: [], crew: [] },
          recommendations: {
            page: 1,
            total_pages: 1,
            results: Array.from({ length: 20 }, (_, i) => film(1000 + i)),
          },
          videos: { results: [] },
          release_dates: { results: [] },
        },
      });
    if (id) return r.fulfill({ json: { ...film(id), credits: { cast: [] } } });
    return r.fulfill({
      json: { page: 1, total_pages: 1, results: Array.from({ length: 20 }, (_, i) => film(i + 1)) },
    });
  });
}

const active = (page) => page.locator('[data-route-page][data-active="true"]');
const position = (page, row) =>
  row.evaluate((region) => ({
    y: Math.round(scrollY),
    x: Math.round(region.querySelector('.track').scrollLeft),
  }));

/** Scroll to a row, along it, and read where the page and the row are. */
async function scrollAlong(page, row) {
  // Rows are rebuilt as late answers arrive, so retry across a replaced element.
  await expect(async () => {
    await row.evaluate((region) => region.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await row.evaluate((region) => region.querySelector('.track').scrollTo({ left: 420 }));
    // The track snaps to a card edge, so the row settles near, not at, the requested offset.
    await expect.poll(() => position(page, row).then((p) => p.x)).toBeGreaterThan(300);
  }).toPass();
  await page.waitForTimeout(400);
  return position(page, row);
}

/** A card of the row lying wholly on screen, so tapping it moves neither the page nor the row. */
const onscreenCard = (row) =>
  row.locator('a.card:visible').evaluateAll((cards) => {
    const index = cards.findIndex((card) => {
      const box = card.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    });
    return index;
  });

async function backRestoresRow(page, name) {
  const row = () => active(page).getByRole('region', { name });
  // Rows load as they near the screen, so go to this one first.
  await row().evaluate((region) => region.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(row().locator('a.card').first()).toBeAttached();
  const left = await scrollAlong(page, row());
  expect(left.y).toBeGreaterThan(200);
  expect(left.x).toBeGreaterThan(300);
  const before = new URL(page.url()).pathname;

  const index = await onscreenCard(row());
  expect(index).toBeGreaterThanOrEqual(0);
  await row().locator('a.card:visible').nth(index).tap();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(before);

  if (page.context().browser().browserType().name() === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  }
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe(before);
  // What a returning page asks for again lands well after the restore, so let it all settle.
  await page.waitForTimeout(2500);
  const back = await position(page, row());
  expect(Math.abs(back.y - left.y), `scrollY ${back.y} vs ${left.y}`).toBeLessThanOrEqual(2);
  expect(Math.abs(back.x - left.x), `row scrollLeft ${back.x} vs ${left.x}`).toBeLessThanOrEqual(2);

  // The restored row still takes a tap.
  const again = row().locator('a.card:visible').first();
  await again.tap();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(before);
}

async function scenario(browser) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  return page;
}

async function detailRestores(browser) {
  const page = await scenario(browser);
  await setup(page, '/search');
  await page.goto(`${E2E_ORIGIN}/test/title-scroll.html`);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
  await page.evaluate(
    (id) =>
      document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: `/movie/${id}` } })),
    TITLE,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'The Title' })).toBeVisible();
  await backRestoresRow(page, 'More like this');
  await page.close();
}

async function browseRestores(browser) {
  const page = await scenario(browser);
  await setup(page, '/');
  await page.goto(`${E2E_ORIGIN}/test/title-scroll.html`);
  const rows = active(page).locator('section.row');
  await expect(rows.nth(4)).toBeAttached();
  const name = await rows.nth(4).getAttribute('aria-label');
  await backRestoresRow(page, name);
  await page.close();
}

test('Back to a title restores the page and its More like this row', async ({ browser }) => {
  await detailRestores(browser);
});

test('Back to Home restores the page and one of its rows', async ({ browser }) => {
  await browseRestores(browser);
});

const needsWebKit = () =>
  test.skip(
    !process.env.CI && !existsSync(webkit.executablePath()),
    'needs WebKit: npx playwright install webkit',
  );

test('Back to a title restores the page and its More like this row in WebKit', async () => {
  needsWebKit();
  const browser = await webkit.launch();
  try {
    await detailRestores(browser);
  } finally {
    await browser.close();
  }
});

test('Back to Home restores the page and one of its rows in WebKit', async () => {
  needsWebKit();
  const browser = await webkit.launch();
  try {
    await browseRestores(browser);
  } finally {
    await browser.close();
  }
});
