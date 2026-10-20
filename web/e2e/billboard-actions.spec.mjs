import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

/** The library fixture at `query`, every title named by a stand-in TMDB whose trending list is Movie 1–12. */
async function open(browser, query, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 852 }, ...options });
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (route) => {
    const [, type, id] =
      new URL(route.request().url()).pathname.match(/\/(movie|tv)\/(\d+)$/) ?? [];
    const title = (id) => ({
      id,
      ...(type === 'tv' ? { name: `Series ${id}` } : { title: `Movie ${id}` }),
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      release_date: '2026-01-01',
      first_air_date: '2026-01-01',
      vote_average: 7.5,
      vote_count: 500,
      genre_ids: [18],
      genres: [{ id: 18, name: 'Drama' }],
      ...(type === 'tv'
        ? {
            seasons: [{ season_number: 1, episode_count: 3 }],
            last_episode_to_air: { season_number: 1, episode_number: 3 },
          }
        : {}),
    });
    return route.fulfill({
      json: id
        ? title(Number(id))
        : { page: 1, total_pages: 1, results: Array.from({ length: 12 }, (_, i) => title(i + 1)) },
    });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="blue"/></svg>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/library.html${query}`);
  return page;
}

const slideTitle = (billboard) => billboard.locator('.slide:not([inert]) h2 .title-link');
const slideButton = (billboard, name) =>
  billboard.locator('.slide:not([inert])').getByRole('button', { name, exact: true });
// Only the slides around the one in front are filled, so a title leaving the rail is seen in the slide count.
const slides = (billboard) => billboard.locator('.slide');

test('a billboard slide saves to the watchlist or marks seen, then moves on without it', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    // Motion left on: the move is the auto-advance's own smooth scroll.
    const page = await open(browser, '');
    const billboard = page.locator('.billboard');
    await expect(slideTitle(billboard)).toHaveText('Movie 1');
    await page.keyboard.press('ArrowRight');
    await expect(slideTitle(billboard)).toHaveText('Movie 2');

    const count = await slides(billboard).count();
    await slideButton(billboard, 'Add to watchlist').click();
    await expect(slideTitle(billboard)).toHaveText('Movie 3');
    await expect(
      page
        .getByRole('region', { name: 'Watchlist', exact: true })
        .getByText('Movie 2', { exact: true }),
    ).toBeVisible();
    // Once the rail has settled the saved title is gone, and paging back finds the slide before it.
    await expect(slides(billboard)).toHaveCount(count - 1);
    await expect(slideTitle(billboard)).toHaveText('Movie 3');
    await page.keyboard.press('ArrowLeft');
    await expect(slideTitle(billboard)).toHaveText('Movie 1');

    await page.keyboard.press('ArrowRight');
    await expect(slideTitle(billboard)).toHaveText('Movie 3');
    await slideButton(billboard, 'Mark as seen').click();
    await expect(slideTitle(billboard)).toHaveText('Movie 4');
    await expect(slides(billboard)).toHaveCount(count - 2);
    await expect(slideTitle(billboard)).toHaveText('Movie 4');
    await page.keyboard.press('ArrowLeft');
    await expect(slideTitle(billboard)).toHaveText('Movie 1');
    await expect(page.getByRole('alert')).toHaveCount(0);

    // A write that fails stays on its slide and says so.
    const failing = await open(browser, '?failing', { reducedMotion: 'reduce' });
    const refused = failing.locator('.billboard');
    await expect(slideTitle(refused)).toHaveText('Movie 1');
    await slideButton(refused, 'Add to watchlist').click();
    await expect(refused.getByRole('alert')).toHaveText('Couldn’t save that. Nothing changed.');
    await expect(slideTitle(refused)).toHaveText('Movie 1');
    await expect(slideButton(refused, 'Add to watchlist')).toBeEnabled();

    // A guest's billboard (no library to write to) has neither button.
    const guest = await open(browser, '', { reducedMotion: 'reduce' });
    await guest.goto(`${E2E_ORIGIN}/test/billboard.html`);
    await guest.evaluate(() => window.dispatchEvent(new Event('fixture:titles')));
    await expect(guest.locator('.slide')).toHaveCount(2);
    await expect(guest.locator('.billboard .pill')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('billboard Play is a native player link and an ordinary click plays in place', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 852 } });
    await guardNetwork(page);
    await routeTmdb(page, (route) =>
      route.fulfill({
        json: {
          id: 42,
          title: 'A short title',
          release_date: '2026-01-01',
          backdrop_path: '/early.jpg',
        },
      }),
    );
    await page.route('https://image.tmdb.org/**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"/>',
      }),
    );
    await page.goto(`${E2E_ORIGIN}/test/billboard.html?play`);
    await page.evaluate(() => {
      window.billboardPlays = [];
      document.addEventListener('fixture:play', (event) =>
        window.billboardPlays.push(event.detail),
      );
      window.dispatchEvent(new Event('fixture:titles'));
    });
    const play = page.locator('.slide:not([inert])').getByRole('link', { name: 'Play' });
    await expect(play).toHaveAttribute('href', '/movie/42-a-short-title?play=1');
    await play.click();
    await expect.poll(() => page.evaluate(() => window.billboardPlays.length)).toBe(1);
    await expect(page).toHaveURL(/\/test\/billboard\.html\?play$/);
  } finally {
    await browser.close();
  }
});

test('billboard keyboard focus stays on actions and treats its pager as one roving stop', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser, '', { reducedMotion: 'reduce' });
    const billboard = page.locator('.billboard');
    const active = () => billboard.locator('.slide:not([inert])');

    await expect(slideTitle(billboard)).toHaveText('Movie 1');
    await expect(active().locator('.slide-link')).toBeHidden();

    const more = active().getByRole('link', { name: 'More' });
    await page.keyboard.press('Tab');
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(slideTitle(billboard)).toHaveText('Movie 2');
    await expect(active().getByRole('link', { name: 'More' })).toBeFocused();

    const dots = billboard.locator('.dot');
    await expect(dots).toHaveCount(9);
    expect(
      await dots.evaluateAll((nodes) => nodes.filter((node) => node.tabIndex === 0).length),
    ).toBe(1);
    await billboard.locator('.dot.on').focus();
    await page.keyboard.press('ArrowRight');
    await expect(slideTitle(billboard)).toHaveText('Movie 3');
    await expect(billboard.locator('.dot.on')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(billboard.locator('.dot:focus')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('the Watchlist billboard offers remove and seen, and moves on from either', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await open(browser, '?populated&page=watchlist', {
      reducedMotion: 'reduce',
      timezoneId: 'UTC',
    });
    const billboard = page.locator('.billboard');
    const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
    await expect(slideTitle(billboard)).toHaveText('Series 2001');
    // Everything here is on the watchlist already: there is nothing to add.
    await expect(slideButton(billboard, 'Remove from watchlist')).toBeVisible();
    await expect(slideButton(billboard, 'Add to watchlist')).toHaveCount(0);

    await slideButton(billboard, 'Remove from watchlist').click();
    await expect(slideTitle(billboard)).toHaveText('Movie 1002');
    await expect(watchlist.getByText('Series 2001')).toHaveCount(0);
    await expect(slides(billboard)).toHaveCount(1);

    // The last slide marked seen: off the watchlist and into Watched, and the billboard goes with it.
    await slideButton(billboard, 'Mark as seen').click();
    await expect(billboard).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Watched', exact: true }).getByText('Movie 1002'),
    ).toBeVisible();

    // A billboard press that didn't save is said once, on its slide, and not again by the page.
    const failing = await open(browser, '?populated&page=watchlist&failing', {
      reducedMotion: 'reduce',
      timezoneId: 'UTC',
    });
    const refused = failing.locator('.billboard');
    await slideButton(refused, 'Remove from watchlist').click();
    await expect(refused.getByRole('alert')).toHaveText('Couldn’t save that. Nothing changed.');
    await expect(failing.getByRole('alert')).toHaveCount(1);
    await expect(slideTitle(refused)).toHaveText('Series 2001');
  } finally {
    await browser.close();
  }
});
