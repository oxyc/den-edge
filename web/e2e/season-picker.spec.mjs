// A series page's seasons are chips while they fit on one line and a single "Season 3" picker when they do not, so a
// long-running series never hides most of its seasons off the side of a scrolling row. Through the real app (App, its
// Router, a guest looking around), in Chromium and WebKit. The picker is a native select: choosing a season goes where
// a chip goes (`?season=N`, its own history entry). The choice is made by measured width, before the first paint,
// and with a margin so a width at the edge settles on one form instead of switching back and forth.
import { test, expect, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

const ID = 78;
const PAGE = `/tv/${ID}-the-long-series`;

/** A series with seasons 1…`count`, and Specials where `specials` is set. */
function seriesWith(count, { specials = false } = {}) {
  const seasons = Array.from({ length: count }, (_, i) => ({
    season_number: i + 1,
    name: `Season ${i + 1}`,
    episode_count: 10,
  }));
  if (specials) seasons.push({ season_number: 0, name: 'Specials', episode_count: 2 });
  return {
    id: ID,
    name: 'The Long Series',
    first_air_date: '2000-01-01',
    last_air_date: '2024-02-01',
    status: 'Ended',
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    overview: 'A series that ran for years.',
    external_ids: {},
    vote_average: 7.6,
    vote_count: 1250,
    genres: [{ id: 18, name: 'Drama' }],
    seasons,
    last_episode_to_air: { season_number: 1, episode_number: 1 },
    aggregate_credits: { cast: [] },
    recommendations: { results: [] },
  };
}

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

/**
 * A guest's browser opening the real app on `series`. Every animation frame notes which form the seasons are in —
 * `chips`, `select`, or nothing yet — so a spec can tell what was on screen, frame by frame, from the first one.
 */
async function guest(page, series) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeGuestEdge(page, newEdge());
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    const season = path.match(new RegExp(`/tv/${ID}/season/(\\d+)$`));
    if (season) return route.fulfill({ json: episodes(Number(season[1])) });
    if (new RegExp(`/tv/${ID}$`).test(path)) return route.fulfill({ json: series });
    return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
  });
  await page.addInitScript(() => {
    localStorage.setItem('den.browsing', '1');
    // Reported to the window rather than thrown, so a page error would not see it.
    const reported = (window.windowErrors = []);
    addEventListener('error', (event) => reported.push(event.message));
    const forms = (window.seasonForms = []);
    const shown = (node) =>
      !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const sample = () => {
      const scope = document.querySelector('[data-route-page][data-active="true"]');
      const chips = shown(scope?.querySelector('[role="tablist"][aria-label="Seasons"]'));
      const select = shown(scope?.querySelector('select[aria-label="Season"]'));
      const form = chips && select ? 'both' : chips ? 'chips' : select ? 'select' : null;
      if (form && forms.at(-1) !== form) forms.push(form);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  return { errors };
}

const forms = (page) => page.evaluate(() => window.seasonForms);
const frames = (page, n = 2) =>
  page.evaluate(
    (count) =>
      new Promise((done) => {
        const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
        step(count);
      }),
    n,
  );

const active = (page) => page.locator('[data-route-page][data-active="true"]');
const picker = (page) => active(page).getByRole('combobox', { name: 'Season', exact: true });
const chips = (page) => active(page).getByRole('tablist', { name: 'Seasons' });
const address = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

async function manySeasonsOnAPhone(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const { errors } = await guest(page, seriesWith(20, { specials: true }));
    await page.goto(`${E2E_ORIGIN}${PAGE}`);
    await expect(active(page).getByText('Season 1 premiere', { exact: true })).toBeVisible();

    // One picker naming the season shown, and no row of chips — not even for a frame before it.
    await expect(picker(page)).toBeVisible();
    await expect(picker(page)).toHaveValue('1');
    await expect(active(page).locator('.season-picker')).toContainText('Season 1');
    await expect(chips(page)).toHaveCount(0);
    expect(await forms(page)).toEqual(['select']);

    // Its options name every season, with its episodes.
    const options = await picker(page).locator('option').allTextContents();
    expect(options).toHaveLength(21);
    expect(options[13]).toBe('Season 14 · 10 episodes');
    expect(options[20]).toBe('Specials · 2 episodes');

    // Choosing one goes where its chip would: the season's episodes, its address, and a step Back undoes.
    await picker(page).selectOption('14');
    await expect(active(page).getByText('Season 14 premiere', { exact: true })).toBeVisible();
    await expect.poll(() => address(page)).toBe(`${PAGE}?season=14`);
    await expect(active(page).locator('.season-picker')).toContainText('Season 14');

    await page.goBack();
    await expect.poll(() => address(page)).toBe(PAGE);
    await expect(active(page).getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await expect(picker(page)).toHaveValue('1');

    // A shared link to a season opens the picker on it.
    await page.goto(`${E2E_ORIGIN}${PAGE}?season=0`);
    await expect(active(page).getByText('The special', { exact: true })).toBeVisible();
    await expect(picker(page)).toHaveValue('0');
    await expect(active(page).locator('.season-picker')).toContainText('Specials');
    expect(await forms(page)).toEqual(['select']);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.windowErrors)).toEqual([]);
  } finally {
    await page.close();
  }
}

async function fewSeasonsOnADesktop(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const { errors } = await guest(page, seriesWith(4));
    await page.goto(`${E2E_ORIGIN}${PAGE}`);
    await expect(active(page).getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await expect(chips(page).getByRole('tab')).toHaveCount(4);
    await expect(chips(page).getByRole('tab', { name: 'Season 2' })).toHaveAttribute(
      'href',
      `${PAGE}?season=2`,
    );
    await expect(picker(page)).toHaveCount(0);
    expect(await forms(page)).toEqual(['chips']);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.windowErrors)).toEqual([]);
  } finally {
    await page.close();
  }
}

/** Chips that just fit stay chips; widths across the edge settle on one form each time, never switching back and forth. */
async function resizingAcrossTheEdge(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const { errors } = await guest(page, seriesWith(8));
    await page.goto(`${E2E_ORIGIN}${PAGE}`);
    await expect(active(page).getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await expect(chips(page)).toBeVisible();

    // The chips' own width, and the window width that leaves their row `slack` pixels more than that. The page's
    // margins grow with the window, so that width is found by measuring rather than by subtracting once.
    const natural = Math.ceil(
      await chips(page).evaluate((node) => node.getBoundingClientRect().width),
    );
    const bar = () =>
      active(page)
        .locator('.season-bar')
        .evaluate((node) => node.clientWidth);
    const widths = new Map();
    const widthFor = async (slack) => {
      if (widths.has(slack)) return widths.get(slack);
      let width = natural + slack + 100;
      for (let tries = 0; tries < 8; tries++) {
        await page.setViewportSize({ width, height: 900 });
        await frames(page);
        const off = natural + slack - (await bar());
        if (off === 0) break;
        width += off;
      }
      expect(await bar(), `row width for ${slack}px`).toBe(natural + slack);
      widths.set(slack, width);
      return width;
    };
    // Found before the run below, which then only switches between widths already known.
    const slacks = [2, -40, 10, 18, 6, 60, 30, 0, 12, -1, 120, -300];
    for (const slack of slacks) await widthFor(slack);

    const at = async (slack, form) => {
      await page.setViewportSize({ width: await widthFor(slack), height: 900 });
      await frames(page, 3);
      await expect(form === 'chips' ? chips(page) : picker(page), `${slack}px`).toBeVisible();
      await expect(form === 'chips' ? picker(page) : chips(page)).toHaveCount(0);
    };

    // Opened just wide enough, the chips show.
    await page.setViewportSize({ width: await widthFor(2), height: 900 });
    await page.reload();
    await expect(active(page).getByText('Season 1 premiere', { exact: true })).toBeVisible();
    await expect(chips(page)).toBeVisible();
    await page.evaluate(() => (window.seasonForms.length = 0));
    await frames(page);

    await at(2, 'chips');
    await at(-40, 'select');
    // Back to just fitting: still the picker, until there is clearly room for the chips.
    for (const slack of [2, 10, 18, 6]) await at(slack, 'select');
    await at(60, 'chips');
    for (const slack of [2, 30, 0, 12]) await at(slack, 'chips');
    await at(-1, 'select');
    // A phone turned back and forth.
    await at(120, 'chips');
    await at(-300, 'select');
    await at(120, 'chips');

    // Each width settled on its form at once, and the last one stays put.
    await frames(page, 30);
    expect(await forms(page)).toEqual([
      'chips',
      'select',
      'chips',
      'select',
      'chips',
      'select',
      'chips',
    ]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.windowErrors)).toEqual([]);
  } finally {
    await page.close();
  }
}

test('a series with many seasons offers one season picker on a phone, which moves the address like a chip', async ({
  browser,
}) => {
  await manySeasonsOnAPhone(browser);
});

test('a series with a few seasons shows them as chips on a desktop', async ({ browser }) => {
  await fewSeasonsOnADesktop(browser);
});

test('seasons that just fit stay chips, and resizing across the edge settles without flapping', async ({
  browser,
}) => {
  await resizingAcrossTheEdge(browser);
});

const needsWebKit = () =>
  test.skip(
    !process.env.CI && !existsSync(webkit.executablePath()),
    'needs WebKit: npx playwright install webkit',
  );

for (const [name, run] of [
  [
    'a series with many seasons offers one season picker on a phone, in WebKit',
    manySeasonsOnAPhone,
  ],
  ['a series with a few seasons shows them as chips on a desktop, in WebKit', fewSeasonsOnADesktop],
  [
    'seasons that just fit stay chips, and resizing settles without flapping, in WebKit',
    resizingAcrossTheEdge,
  ],
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
