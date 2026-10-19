// The season a series page shows is in its address (`/tv/77-the-series?season=2`), through the real app: App, its
// Router and the library around it, as a guest looking around. Picking a season is somewhere the viewer went, so Back
// returns to the season before, then leaves the page; a reload or a shared link opens on that season, and only that
// season is ever asked for. Each season is a real link, so it can be opened in a new tab without moving this page.
// At a phone's size, with touch, in Chromium and WebKit.
import { test, expect, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

const ID = 77;
const PAGE = `/tv/${ID}-the-series`;

const series = {
  id: ID,
  name: 'The Series',
  first_air_date: '2020-01-01',
  last_air_date: '2024-02-01',
  status: 'Ended',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  overview: 'A mystery unfolds in a remote village.',
  external_ids: {},
  vote_average: 7.6,
  vote_count: 1250,
  genres: [{ id: 18, name: 'Drama' }],
  seasons: [
    { season_number: 1, name: 'Season 1', episode_count: 1 },
    { season_number: 2, name: 'Season 2', episode_count: 1 },
    { season_number: 3, name: 'Season 3', episode_count: 1 },
    { season_number: 0, name: 'Specials', episode_count: 1 },
  ],
  last_episode_to_air: { season_number: 3, episode_number: 1 },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};
const episodes = (n) => ({
  episodes: [
    {
      episode_number: 1,
      name: n === 0 ? 'The special' : `Season ${n} premiere`,
      still_path: `/s${n}.jpg`,
      runtime: 50,
      air_date: '2021-01-01',
      overview: 'An episode.',
    },
  ],
});

/** A guest's browser opening the real app, with every season asked for TMDB noted in `seasons`. */
async function guest(page) {
  const seasons = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeGuestEdge(page, newEdge());
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    const season = path.match(new RegExp(`/tv/${ID}/season/(\\d+)$`));
    if (season) {
      seasons.push(Number(season[1]));
      return route.fulfill({ json: episodes(Number(season[1])) });
    }
    if (new RegExp(`/tv/${ID}$`).test(path)) return route.fulfill({ json: series });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  // Looking around, as "Look around instead" leaves it: the app with no library behind it.
  await page.addInitScript(() => localStorage.setItem('den.browsing', '1'));
  return { seasons, errors };
}

/**
 * Every season the page has selected since the document began, in order — each document's own, so a reload starts
 * again. Read from the DOM, since a season the app already holds is drawn without asking TMDB again.
 */
async function recordSelections(page) {
  await page.addInitScript(() => {
    const selected = (window.selectedSeasons = []);
    const note = () => {
      const tab = document.querySelector(
        '[data-route-page][data-active="true"] [role="tablist"][aria-label="Seasons"] [aria-selected="true"]',
      );
      const name = tab?.textContent.trim();
      if (name && selected.at(-1) !== name) selected.push(name);
    };
    new MutationObserver(note).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'data-active'],
    });
  });
}
const selections = (page) => page.evaluate(() => window.selectedSeasons);

const active = (page) => page.locator('[data-route-page][data-active="true"]');
const tab = (page, name) => active(page).getByRole('tab', { name, exact: true });
const address = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

/** The season on screen: its tab chosen and its episode listed. */
async function showing(page, name, episode) {
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(active(page).getByText(episode, { exact: true })).toBeVisible();
}

async function backThroughSeasons(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const { errors } = await guest(page);
    await page.goto(`${E2E_ORIGIN}/`);
    await expect(page.locator('main')).toBeVisible();
    await page.evaluate(
      (path) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path } })),
      PAGE,
    );
    await showing(page, 'Season 1', 'Season 1 premiere');
    expect(address(page)).toBe(PAGE);

    // Each season is a link to its own address.
    await expect(tab(page, 'Season 2')).toHaveAttribute('href', `${PAGE}?season=2`);
    await expect(tab(page, 'Specials')).toHaveAttribute('href', `${PAGE}?season=0`);

    // The page, to tell it apart from a new one mounted in its place.
    await active(page).evaluate((node) => (window.seasonPage = node));

    await tab(page, 'Season 2').tap();
    await showing(page, 'Season 2', 'Season 2 premiere');
    await expect.poll(() => address(page)).toBe(`${PAGE}?season=2`);
    await tab(page, 'Season 3').tap();
    await showing(page, 'Season 3', 'Season 3 premiere');
    await expect.poll(() => address(page)).toBe(`${PAGE}?season=3`);

    await page.goBack();
    await expect.poll(() => address(page)).toBe(`${PAGE}?season=2`);
    await showing(page, 'Season 2', 'Season 2 premiere');
    await page.goBack();
    await expect.poll(() => address(page)).toBe(PAGE);
    await showing(page, 'Season 1', 'Season 1 premiere');
    // The same page throughout, not a new one per season.
    expect(await active(page).evaluate((node) => node === window.seasonPage)).toBe(true);

    await page.goForward();
    await expect.poll(() => address(page)).toBe(`${PAGE}?season=2`);
    await showing(page, 'Season 2', 'Season 2 premiere');
    await page.goBack();
    await showing(page, 'Season 1', 'Season 1 premiere');

    await page.goBack();
    await expect.poll(() => address(page)).toBe('/');
    await expect(active(page).getByRole('tablist', { name: 'Seasons' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}

async function opensOnTheAddressedSeason(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const { seasons, errors } = await guest(page);
    await recordSelections(page);
    await page.goto(`${E2E_ORIGIN}${PAGE}?season=2`);
    await showing(page, 'Season 2', 'Season 2 premiere');
    // Season 2 directly: no other season was drawn, or asked for, on the way.
    expect(await selections(page)).toEqual(['Season 2']);
    expect(seasons).toEqual([2]);

    await page.reload();
    await showing(page, 'Season 2', 'Season 2 premiere');
    expect(await selections(page)).toEqual(['Season 2']);
    expect(seasons).not.toContain(1);

    await page.goto(`${E2E_ORIGIN}${PAGE}?season=0`);
    await showing(page, 'Specials', 'The special');
    expect(await selections(page)).toEqual(['Specials']);

    // What the address cannot mean is the page's own choice, with nothing broken.
    for (const wrong of ['abc', '9', '-1']) {
      await page.goto(`${E2E_ORIGIN}${PAGE}?season=${wrong}`);
      await showing(page, 'Season 1', 'Season 1 premiere');
      expect(await selections(page), wrong).toEqual(['Season 1']);
    }
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}

/** A modified click opens the season's link in a new tab and leaves this page on the season it shows. */
async function modifiedClickLeavesThePage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    const { errors } = await guest(page);
    await page.goto(`${E2E_ORIGIN}${PAGE}`);
    await showing(page, 'Season 1', 'Season 1 premiere');
    // The new tab's own document: what matters here is only where the browser opened it.
    await context.route(`${E2E_ORIGIN}${PAGE}?season=2`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Opened</title>' }),
    );
    const opened = context.waitForEvent('page');
    await tab(page, 'Season 2').click({ modifiers: ['ControlOrMeta'] });
    const other = await opened;
    await expect.poll(() => other.url()).toBe(`${E2E_ORIGIN}${PAGE}?season=2`);
    await other.close();
    expect(address(page)).toBe(PAGE);
    await showing(page, 'Season 1', 'Season 1 premiere');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

test('picking seasons gives each its address, and Back walks them before leaving the page', async ({
  browser,
}) => {
  await backThroughSeasons(browser);
});

test('a series page opens on the season its address names, and on its own choice for one it cannot', async ({
  browser,
}) => {
  await opensOnTheAddressedSeason(browser);
});

test('a modified click on a season opens it in a new tab and leaves this page’s season', async ({
  browser,
}) => {
  await modifiedClickLeavesThePage(browser);
});

const needsWebKit = () =>
  test.skip(
    !process.env.CI && !existsSync(webkit.executablePath()),
    'needs WebKit: npx playwright install webkit',
  );

for (const [name, run] of [
  ['picking seasons gives each its address, and Back walks them, in WebKit', backThroughSeasons],
  ['a series page opens on the season its address names, in WebKit', opensOnTheAddressedSeason],
  ['a modified click on a season leaves this page’s season, in WebKit', modifiedClickLeavesThePage],
])
  test(name, async () => {
    needsWebKit();
    const browser = await webkit.launch();
    try {
      await run(browser);
    } finally {
      await browser.close();
    }
  });
