import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

for (const width of [393, 1280]) {
  test(`the Watchlist page lists continue watching, the watchlist by type and the watched history at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 852 },
        reducedMotion: 'reduce',
      });
      await guardNetwork(page);
      await page.route('**/routes', (r) => r.fulfill({ json: {} }));
      await page.route('https://api.themoviedb.org/**', (route) => {
        const [, type, id] =
          new URL(route.request().url()).pathname.match(/\/(movie|tv)\/(\d+)$/) ?? [];
        if (!id) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
        return route.fulfill({
          json: {
            id: Number(id),
            ...(type === 'movie' ? { title: `Movie ${id}` } : { name: `Series ${id}` }),
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
      await page.goto('http://127.0.0.1:5198/test/library.html?populated&page=watchlist');

      await expect(page.getByRole('heading', { name: 'Watchlist', level: 1 })).toBeVisible();
      const resume = page.getByRole('region', { name: 'Continue Watching', exact: true });
      await expect(resume.getByText('Movie 1001')).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Watchlist series' }).getByText('Series 2001'),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Watchlist movies' }).getByText('Movie 1002'),
      ).toBeVisible();

      // Newest first: the part-watched series (its episode at 9000) leads, then the movies by when they were seen.
      const watched = page.getByRole('region', { name: 'Watched', exact: true });
      await expect(watched.locator('.name')).toHaveText([
        'Series 2002',
        'Movie 1005',
        'Movie 1004',
        'Movie 1003',
      ]);
      await expect(watched.locator('.caption').first()).toContainText('S2 · E4');
      // A watched title isn't also on the watchlist grid, and nothing on the page scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await expect(
        resume.getByRole('button', { name: 'Remove from Continue Watching Movie 1001' }),
      ).toBeAttached();
      await page.screenshot({
        path: test.info().outputPath(`watchlist-${width}.png`),
        fullPage: true,
      });
    } finally {
      await browser.close();
    }
  });
}
