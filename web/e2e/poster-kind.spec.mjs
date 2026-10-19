import { chromium, expect, test, webkit } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

/** The season layout the stand-in TMDB gives each library series: Series 2004 has one season, Series 2005 four. */
const LAYOUTS = { 2004: [12], 2005: [8, 10, 6, 9] };

/**
 * Home at phone width on a library whose watchlist holds a film and two series, under a stand-in TMDB whose lists carry one
 * series the library does not hold. TMDB's list answers have no season counts, so that one says only "Series".
 */
async function openHome(browser) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    const [, type, id] = path.match(/\/(movie|tv)\/(\d+)$/) ?? [];
    if (!id) {
      const series = /\/tv\b/.test(path);
      return route.fulfill({
        json: {
          page: 1,
          total_pages: 1,
          results: [
            series
              ? { id: 7001, name: 'Unheld series', first_air_date: '2019-03-01' }
              : { id: 7002, title: 'Unheld movie', release_date: '2019-03-01' },
          ].map((result) => ({
            ...result,
            poster_path: '/poster.jpg',
            vote_average: 7,
            vote_count: 500,
          })),
        },
      });
    }
    const seasons = (LAYOUTS[id] ?? [8, 10]).map((episodes, index) => ({
      season_number: index + 1,
      episode_count: episodes,
    }));
    return route.fulfill({
      json: {
        id: Number(id),
        ...(type === 'movie'
          ? { title: `Movie ${id}`, release_date: '2019-01-01' }
          : {
              name: `Series ${id}`,
              first_air_date: '2019-01-01',
              // Specials are listed as season 0 and are not a season of the series.
              seasons: [{ season_number: 0, episode_count: 3 }, ...seasons],
            }),
        poster_path: '/poster.jpg',
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
  await page.goto(`${E2E_ORIGIN}/test/library.html?populated&series-kinds`);
  return page;
}

for (const [name, engine] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
]) {
  test(`a poster's year line tells a series from a film at phone width in ${name}`, async () => {
    const browser = await engine.launch(
      engine === chromium
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      const page = await openHome(browser);
      const line = (title) =>
        page
          .locator('a.card', { has: page.locator('.name', { hasText: title }) })
          .first()
          .locator('.caption');
      const watchlist = page.getByRole('region', { name: 'Watchlist', exact: true });
      await expect(watchlist.locator('.name')).toHaveText([
        'Series 2005',
        'Series 2004',
        'Movie 1002',
      ]);
      // A film is its year alone; a series the library holds counts its seasons, or its only season's episodes.
      await expect(line('Movie 1002')).toHaveText('2019');
      await expect(line('Series 2005')).toHaveText('2019 · 4 seasons');
      await expect(line('Series 2004')).toHaveText('2019 · 12 episodes');
      // The longest of them fits its card: cut short with an ellipsis, never wrapped onto a third line.
      const caption = line('Series 2005');
      const fits = await caption.evaluate((node) => ({
        overflow: getComputedStyle(node).textOverflow,
        lines: Math.round(
          node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
        ),
      }));
      expect(fits).toEqual({ overflow: 'ellipsis', lines: 1 });
      // The element's own scroll: Playwright's leaves WebKit's window where it is.
      const reveal = (region) =>
        region.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await reveal(watchlist);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${name}-library.png`) });

      // A series from a TMDB list, whose layout nothing here holds, says only that it is one. Its row mounts its
      // cards as it nears the screen.
      const row = page.getByRole('region', {
        name: 'Because you added Series 2005 to your Watchlist',
      });
      const films = page.getByRole('region', { name: 'Because you watched Movie 1005' });
      await reveal(films);
      await expect(films.locator('.caption')).toHaveText(['2019']);
      await reveal(row);
      await expect(row.locator('.caption')).toHaveText(['2019 · Series']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${name}-rows.png`) });
    } finally {
      await browser.close();
    }
  });
}
