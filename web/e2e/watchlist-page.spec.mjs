import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';

/** The library fixture's Watchlist page at `width`, every title named by a stand-in TMDB. */
async function openWatchlist(browser, width, query = '') {
  const page = await browser.newPage({
    viewport: { width, height: 852 },
    reducedMotion: 'reduce',
    // Watches are filed by the viewer's calendar; the fixture's, a few seconds into 1970, stay in 1970 in UTC.
    timezoneId: 'UTC',
  });
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (route) => {
    const [, type, id] =
      new URL(route.request().url()).pathname.match(/\/(movie|tv)\/(\d+)$/) ?? [];
    if (!id) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    return route.fulfill({
      json: {
        id: Number(id),
        ...(type === 'movie'
          ? { title: `Movie ${id}` }
          : {
              name: `Series ${id}`,
              seasons: [
                { season_number: 1, episode_count: 8 },
                { season_number: 2, episode_count: 10 },
              ],
              last_episode_to_air: { season_number: 2, episode_number: 6 },
            }),
        poster_path: '/poster.jpg',
        release_date: '2026-01-01',
        first_air_date: '2026-01-01',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18, name: 'Drama' }],
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="blue"/></svg>',
    }),
  );
  await page.goto(`http://127.0.0.1:5198/test/library.html?populated&page=watchlist${query}`);
  return page;
}

test('Watched lists the years it has watches in and shows one at a time', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const width = 393;
    const page = await openWatchlist(browser, width, '&years');
    const watched = page.getByRole('region', { name: 'Watched', exact: true });
    const year = watched.getByRole('combobox', { name: 'Year watched' });
    // Newest first with each year's count, the oldest dated year saying how far back it goes, the undated last.
    await expect(year.locator('option')).toHaveText([
      'All years',
      '2024 (1)',
      '2019 (1)',
      '1970 (4)',
      'Unknown (1)',
    ]);
    await expect(watched.locator('.name')).toHaveCount(7);

    await year.selectOption('2019');
    await expect(watched.locator('.name')).toHaveText(['Movie 1006']);
    await expect(watched.getByRole('heading', { name: /Watched/ })).toHaveText('Watched 1');

    // The undated are under Unknown rather than nowhere.
    await year.selectOption('unknown');
    await expect(watched.locator('.name')).toHaveText(['Movie 1007']);

    // The year holds under a type tab, which counts only its own.
    await year.selectOption('1970');
    await watched
      .getByRole('group', { name: 'Show in Watched' })
      .getByRole('button', { name: 'Series' })
      .click();
    await expect(watched.locator('.name')).toHaveText(['Series 2002']);
    await expect(year.locator('option')).toHaveText(['All years', '2024 (1)', '1970 (1)']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

    await year.selectOption('');
    await expect(watched.locator('.name')).toHaveText(['Series 2003', 'Series 2002']);
  } finally {
    await browser.close();
  }
});

test('the Watchlist billboard shows the watchlist, newest addition first, and goes when it empties', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const page = await openWatchlist(browser, 1280);
    const billboard = page.locator('.billboard');
    // Series 2001 was added after Movie 1002. Neither the part-watched series nor anything watched is on it.
    await expect(billboard.locator('.slide')).toHaveCount(2);
    const slides = await billboard.locator('.slide').allTextContents();
    expect(slides.map((text) => /(Movie|Series) \d+/.exec(text)?.[0])).toEqual([
      'Series 2001',
      'Movie 1002',
    ]);

    const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
    for (const title of ['Movie 1002', 'Series 2001']) {
      await watchlist.getByRole('link', { name: new RegExp(title) }).hover();
      await watchlist
        .getByRole('button', { name: `Remove from Watchlist ${title}`, exact: true })
        .click();
    }
    await expect(watchlist).toHaveCount(0);
    await expect(billboard).toHaveCount(0);

    // An empty library has no billboard on its Watchlist page at all.
    const empty = await browser.newPage({ viewport: { width: 1280, height: 852 } });
    await guardNetwork(empty);
    await empty.route('**/routes', (r) => r.fulfill({ json: {} }));
    await empty.goto('http://127.0.0.1:5198/test/library.html?page=watchlist');
    await expect(empty.getByRole('heading', { name: 'Watchlist', level: 1 })).toBeVisible();
    await expect(empty.locator('.billboard')).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

for (const width of [393, 1280]) {
  test(`the Watchlist page lists continue watching, the watchlist by type and the watched history at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await openWatchlist(browser, width);

      await expect(page.getByRole('heading', { name: 'Watchlist', level: 1 })).toBeVisible();
      const resume = page.getByRole('region', { name: 'Continue Watching', exact: true });
      await expect(resume.getByText('Movie 1001')).toBeVisible();
      const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
      await expect(watchlist.getByText('Series 2001')).toBeVisible();
      await expect(watchlist.getByText('Movie 1002')).toBeVisible();

      // The watchlist takes the same three tabs as Watched, rather than standing as two headed sections.
      const savedFilter = watchlist.getByRole('group', { name: 'Show in Watchlist' });
      await savedFilter.getByRole('button', { name: 'Series' }).click();
      await expect(watchlist.locator('.name')).toHaveText(['Series 2001']);
      await savedFilter.getByRole('button', { name: 'Movies' }).click();
      await expect(watchlist.locator('.name')).toHaveText(['Movie 1002']);
      await savedFilter.getByRole('button', { name: 'All' }).click();
      await expect(watchlist.locator('.name')).toHaveCount(2);

      // Newest first: the part-watched series (its episode at 9000) leads, then the movies by when they were seen.
      const watched = page.getByRole('region', { name: 'Watched', exact: true });
      await expect(watched.locator('.name')).toHaveText([
        'Series 2002',
        'Movie 1005',
        'Movie 1004',
        'Movie 1003',
      ]);
      // A series counts its seen episodes against those aired so far (8 + 6 of season 2's 10).
      await expect(watched.locator('.caption').first()).toContainText('1 of 14 episodes');
      // Nothing on the page scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await expect(
        resume.getByRole('button', { name: 'Remove from Continue Watching Movie 1001' }),
      ).toBeAttached();
      await expect(
        page.getByRole('button', { name: 'Mark watched Series 2001', exact: true }),
      ).toBeAttached();
      await expect(
        watched.getByRole('button', { name: 'Mark unwatched Movie 1003', exact: true }),
      ).toBeAttached();

      // Unmarking a series asks first, on the same button. Where there's a pointer, the buttons take clicks only once
      // the card is pointed at.
      const unmark = watched.getByRole('button', { name: 'Mark unwatched Series 2002' });
      await watched.getByRole('link', { name: /Series 2002/ }).hover();
      await unmark.click();
      await expect(
        watched.getByRole('button', { name: 'Unmark all episodes? Series 2002' }),
      ).toBeVisible();
      await watched.getByRole('heading', { name: /Watched/ }).click();
      await expect(unmark).toBeAttached();

      const filter = watched.getByRole('group', { name: 'Show in Watched' });
      await filter.getByRole('button', { name: 'Series' }).click();
      await expect(watched.locator('.name')).toHaveText(['Series 2002']);
      await filter.getByRole('button', { name: 'Movies' }).click();
      await expect(watched.locator('.name')).toHaveText(['Movie 1005', 'Movie 1004', 'Movie 1003']);
      await filter.getByRole('button', { name: 'All' }).click();
      await expect(watched.locator('.name')).toHaveCount(4);

      // What the cards do is written to the library and drawn back from it. A card's buttons take clicks once the
      // card is pointed at.
      const press = async (region, title, name) => {
        await region
          .getByRole('link', { name: new RegExp(title) })
          .first()
          .hover();
        await region.getByRole('button', { name, exact: true }).click();
      };

      // Off Continue Watching, and off the watchlist.
      await press(resume, 'Movie 1001', 'Remove from Continue Watching Movie 1001');
      await expect(resume.getByText('Movie 1001')).toHaveCount(0);
      // Taken off, and nothing said about it failing.
      await expect(page.getByRole('alert')).toHaveCount(0);
      await press(watchlist, 'Movie 1002', 'Remove from Watchlist Movie 1002');
      await expect(watchlist.getByText('Movie 1002')).toHaveCount(0);

      // A series marked watched takes every aired episode with it: off the watchlist, into Watched in full. It
      // was the last one there, so the section goes with it.
      await press(watchlist, 'Series 2001', 'Mark watched Series 2001');
      await expect(watchlist).toHaveCount(0);
      await expect(watched.getByRole('link', { name: /Series 2001/ })).toContainText(
        '14 of 14 episodes',
      );

      // A movie comes off Watched at once; a series only after the question is answered.
      await press(watched, 'Movie 1003', 'Mark unwatched Movie 1003');
      await expect(watched.getByText('Movie 1003')).toHaveCount(0);
      await press(watched, 'Series 2002', 'Mark unwatched Series 2002');
      await watched
        .getByRole('button', { name: 'Unmark all episodes? Series 2002', exact: true })
        .click();
      await expect(watched.getByText('Series 2002')).toHaveCount(0);
      await expect(watched.locator('.name')).toHaveText([
        'Series 2001',
        'Movie 1005',
        'Movie 1004',
      ]);
      await page.screenshot({
        path: test.info().outputPath(`watchlist-${width}.png`),
        fullPage: true,
      });
    } finally {
      await browser.close();
    }
  });
}
