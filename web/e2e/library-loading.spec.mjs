import { test, expect, chromium } from '@playwright/test';
import { guardNetwork } from './network.mjs';

for (const [width, failed] of [
  [393, false],
  [1280, false],
  [393, true],
]) {
  test(`initial library shelves settle together at ${width}px${failed ? ' with unavailable metadata' : ''}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: 852 },
        reducedMotion: 'reduce',
      });
      await guardNetwork(page);
      const gates = new Map(),
        requested = new Set();
      for (const id of [1001, 1002, 1003, 1004, 1005]) {
        let release;
        const promise = new Promise((resolve) => {
          release = resolve;
        });
        gates.set(id, { promise, release });
      }
      await page.route('**/routes', (r) => r.fulfill({ json: {} }));
      await page.route('https://api.themoviedb.org/**', async (route) => {
        const url = new URL(route.request().url());
        const id = Number(url.pathname.match(/\/(?:movie|tv)\/(\d+)$/)?.[1]);
        if (gates.has(id)) {
          requested.add(id);
          await gates.get(id).promise;
          if (failed && id === 1001) return route.fulfill({ status: 404, json: {} });
        }
        const movie = (id) => ({
          id,
          title: `Movie ${id}`,
          name: `Series ${id}`,
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          release_date: '2026-01-01',
          vote_average: 7.5,
          vote_count: 500,
          genre_ids: [18],
        });
        await route.fulfill({
          json: id
            ? movie(id)
            : {
                page: 1,
                total_pages: 1,
                results: Array.from({ length: 12 }, (_, i) => movie(i + 1)),
              },
        });
      });
      await page.route('https://image.tmdb.org/**', (r) =>
        r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="blue"/></svg>',
        }),
      );
      await page.addInitScript(() => {
        window.shifts = [];
        new PerformanceObserver((list) =>
          window.shifts.push(
            ...list
              .getEntries()
              .filter((e) => !e.hadRecentInput)
              .map((e) => e.value),
          ),
        ).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto('http://127.0.0.1:5198/test/library.html?populated');
      await expect.poll(() => requested.size).toBe(4);
      expect(requested.has(1003), 'older watched history should wait for visible shelves').toBe(
        false,
      );
      gates.get(1001).release();
      gates.get(1005).release();
      await expect(page.locator('section.row')).toHaveCount(0);
      gates.get(1002).release();
      gates.get(1004).release();
      if (!failed)
        await expect(
          page.getByRole('region', { name: 'Continue Watching', exact: true }),
        ).toBeVisible();
      else
        await expect(
          page.getByRole('region', { name: 'Continue Watching', exact: true }),
        ).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Watchlist', exact: true })).toBeAttached();
      await expect(page.locator('section.row .card').first()).toBeVisible();
      await expect.poll(() => requested.has(1003)).toBe(true);
      const positions = () =>
        page.locator('section.row').evaluateAll((rows) =>
          rows.slice(0, 5).map((row) => ({
            label: row.getAttribute('aria-label'),
            top: row.getBoundingClientRect().top + scrollY,
          })),
        );
      const before = await positions();
      gates.get(1003).release();
      await page.waitForTimeout(250);
      expect(await positions()).toEqual(before);
      const shifts = await page.evaluate(() => window.shifts.reduce((a, b) => a + b, 0));
      expect(shifts).toBeLessThan(0.05);
    } finally {
      await browser.close();
    }
  });
}
