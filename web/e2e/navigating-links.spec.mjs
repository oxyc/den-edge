// Everything that goes somewhere is a real link, through the real app as a guest looking around: an episode row, an
// Explore chip, a Browse-row suggestion, a "Try describing it" prompt and a poster menu's More like this. Each carries
// the address it leads to; a Ctrl/Cmd-click opens that address in a new tab and leaves this page where it is; a plain
// click stays in the app — the chips, suggestion, prompt and menu item are followed in place by the Router, with no
// reload, and an episode row starts playback without moving the detail route. A non-playing episode address opens
// its season with it scrolled into view and briefly marked. At phone and desktop widths, in Chromium and WebKit.
import { test, expect, webkit } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';
import { openedByBrowser, stubNewTab } from './new-tab.mjs';

const ID = 77;
const PAGE = `/tv/${ID}-the-series`;
const EPISODES = 12;

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};

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
    { season_number: 1, name: 'Season 1', episode_count: EPISODES },
    { season_number: 2, name: 'Season 2', episode_count: EPISODES },
  ],
  last_episode_to_air: { season_number: 2, episode_number: EPISODES },
  aggregate_credits: { cast: [] },
  recommendations: { results: [] },
};
const season = (n) => ({
  episodes: Array.from({ length: EPISODES }, (_, i) => ({
    episode_number: i + 1,
    name: `Season ${n}, episode ${i + 1}`,
    still_path: `/s${n}e${i + 1}.jpg`,
    runtime: 50,
    air_date: '2021-01-01',
    overview: 'An episode.',
  })),
});
const movie = {
  id: 550,
  title: 'Fight Club',
  release_date: '1999-10-15',
  poster_path: '/fight-club.jpg',
  vote_average: 8,
  vote_count: 900,
  genre_ids: [18],
  original_language: 'en',
};

/** A guest's browser opening the real app: one series, and one film wherever a list is asked for. */
async function guest(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeGuestEdge(page, newEdge());
  await routeTmdb(page, (route) => {
    const url = new URL(route.request().url());
    const episodes = url.pathname.match(new RegExp(`/tv/${ID}/season/(\\d+)$`));
    if (episodes) return route.fulfill({ json: season(Number(episodes[1])) });
    if (new RegExp(`/tv/${ID}$`).test(url.pathname)) return route.fulfill({ json: series });
    const first = (url.searchParams.get('page') ?? '1') === '1';
    return route.fulfill({
      json: { page: 1, total_pages: 1, results: first ? [movie] : [] },
    });
  });
  await page.addInitScript(() => localStorage.setItem('den.browsing', '1'));
  return { errors };
}

const active = (page) => page.locator('[data-route-page][data-active="true"]');
const address = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

/**
 * The kinds of link, each with the page it is on, where it leads, and the address a plain click leaves the page at.
 * `open` finds it, doing whatever it takes to show it (a menu).
 */
const KINDS = [
  {
    name: 'an episode row',
    from: `${PAGE}?season=2`,
    open: async (page) => {
      const row = active(page).getByRole('link', {
        name: 'Play episode 3: Season 2, episode 3',
        exact: true,
      });
      await row.scrollIntoViewIfNeeded();
      return row;
    },
    href: `${PAGE}?season=2&episode=3&play=1`,
    // A plain click plays, as it always has (a guest has nothing to play it with): the page does not move.
    after: `${PAGE}?season=2`,
  },
  {
    name: 'an Explore chip',
    from: '/search',
    open: async (page) => active(page).locator('a[data-chip="genre-18"]:visible'),
    href: '/search?c=genre-18',
  },
  {
    name: 'a Browse-row suggestion',
    from: '/search?q=drama',
    open: async (page) => active(page).locator('.browse a[data-chip="genre-18"]'),
    href: '/search?c=genre-18',
  },
  {
    name: 'a "Try describing it" prompt',
    from: '/search',
    open: async (page) =>
      active(page)
        .getByRole('group', { name: 'Try describing it' })
        .getByRole('link', { name: '“funny heist”', exact: true }),
    href: '/search?q=funny%20heist',
  },
  {
    name: 'a poster menu’s More like this',
    from: '/search',
    open: async (page) => {
      await active(page).getByRole('button', { name: 'Actions for Fight Club' }).first().click();
      return page.getByRole('menuitem', { name: 'More like this', exact: true });
    },
    href: '/search?c=like-movie-550',
  },
];

async function opensInPlace(browser, kind, viewport) {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    const { errors } = await guest(page);
    await page.goto(`${E2E_ORIGIN}${kind.from}`);
    const link = await kind.open(page);
    await expect(link).toHaveAttribute('href', kind.href);
    await page.evaluate(() => (window.sameDocument = true));
    const entries = await page.evaluate(() => history.length);
    await link.click({ timeout: 10_000 });
    const after = kind.after ?? kind.href;
    await expect.poll(() => address(page)).toBe(after);
    // Followed by the Router, in this document: no reload.
    expect(await page.evaluate(() => window.sameDocument)).toBe(true);
    if (after === kind.from) {
      // Nothing to follow: no entry was written for it either, and the page did not move later.
      await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
      expect(await page.evaluate(() => history.length)).toBe(entries);
      expect(address(page)).toBe(after);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

async function opensInANewTab(browser, kind, viewport) {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    const { errors } = await guest(page);
    await page.goto(`${E2E_ORIGIN}${kind.from}`);
    const link = await kind.open(page);
    await expect(link).toHaveAttribute('href', kind.href);
    await page.evaluate(() => (window.sameDocument = true));
    // The new tab is the browser's own, and only where it opened matters: its document is a stub.
    const opening = `${E2E_ORIGIN}${kind.href}`;
    await stubNewTab(context, opening);
    const click = () => link.click({ modifiers: ['ControlOrMeta'], timeout: 10_000 });
    expect(await openedByBrowser(browser, context, page, click)).toEqual([opening]);
    expect(address(page)).toBe(kind.from);
    expect(await page.evaluate(() => window.sameDocument)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

/** Every episode the page marked as one an address named, in order. */
async function recordAddressed(page) {
  await page.addInitScript(() => {
    const marked = (window.addressedEpisodes = []);
    new MutationObserver((changes) => {
      for (const change of changes)
        if (change.target instanceof Element && change.target.hasAttribute('data-addressed'))
          marked.push(change.target.getAttribute('data-episode'));
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-addressed'] });
  });
}

async function opensOnTheEpisode(browser, viewport) {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    const { errors } = await guest(page);
    await recordAddressed(page);
    await page.goto(`${E2E_ORIGIN}${PAGE}?season=2&episode=9`);
    await expect(active(page).getByRole('tab', { name: 'Season 2', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 15_000 },
    );
    const row = active(page)
      .locator('.episode')
      .filter({ has: page.getByText('Season 2, episode 9', { exact: true }) });
    await expect(row.getByText('Season 2, episode 9', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(row).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.addressedEpisodes)).toEqual(['9']);
    // The page went down to it: the episode is below the first screen.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(address(page)).toBe(`${PAGE}?season=2&episode=9`);
    // The mark fades and goes.
    await expect(row).not.toHaveAttribute('data-addressed', /.*/, { timeout: 10_000 });

    // An episode the season does not have, or that is no episode at all, is passed over: the season still opens, the
    // page stays at its top and the address is left as it is.
    for (const wrong of ['99', 'abc', '-1']) {
      await page.goto(`${E2E_ORIGIN}${PAGE}?season=2&episode=${wrong}`);
      await expect(
        active(page).getByText('Season 2, episode 1', { exact: true }),
        wrong,
      ).toBeVisible();
      await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
      expect(await page.evaluate(() => window.addressedEpisodes), wrong).toEqual([]);
      expect(await page.evaluate(() => window.scrollY), wrong).toBe(0);
      expect(address(page), wrong).toBe(`${PAGE}?season=2&episode=${wrong}`);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

const needsWebKit = () =>
  test.skip(
    !process.env.CI && !existsSync(webkit.executablePath()),
    'needs WebKit: npx playwright install webkit',
  );

const BROWSERS = {
  Chromium:
    (run) =>
    async ({ browser }) =>
      run(browser),
  WebKit: (run) => async () => {
    needsWebKit();
    const browser = await webkit.launch();
    try {
      await run(browser);
    } finally {
      await browser.close();
    }
  },
};

for (const [engine, using] of Object.entries(BROWSERS))
  for (const [width, viewport] of Object.entries(VIEWPORTS)) {
    for (const kind of KINDS) {
      test(
        `${kind.name} is a link, and a plain click stays in the app (${engine}, ${width})`,
        using((browser) => opensInPlace(browser, kind, viewport)),
      );
      test(
        `${kind.name} opens in a new tab and leaves this page (${engine}, ${width})`,
        using((browser) => opensInANewTab(browser, kind, viewport)),
      );
    }
    test(
      `an episode’s address opens its season with that episode in view (${engine}, ${width})`,
      using((browser) => opensOnTheEpisode(browser, viewport)),
    );
  }
