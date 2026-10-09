import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

test('local library keeps its progressive page visible while startup settles', async ({ page }) => {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { page: 1, results: [] } }));

  await page.goto(`${E2E_ORIGIN}/test/library.html?local&hold-open`);

  await expect(page.getByText('Loading your library', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.denTestReleaseLibraryOpen());
});

for (const local of [false, true]) {
  test(`${local ? 'local' : 'linked'} library startup failure is visible and Retry recovers`, async ({
    page,
  }) => {
    await guardNetwork(page);
    await page.route('**/routes', (route) => route.fulfill({ json: {} }));
    await routeTmdb(page, (route) => route.fulfill({ json: { page: 1, results: [] } }));

    await page.goto(
      `${E2E_ORIGIN}/test/library.html?open-failure${local ? '&local&storage-timeout' : ''}`,
    );

    await expect(page.getByRole('heading', { name: 'Couldn’t open your library' })).toBeVisible();
    await expect(
      page.getByText(
        local
          ? 'Library storage timed out while opening IndexedDB'
          : 'fixture library service did not start',
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(page.getByRole('heading', { name: 'Couldn’t open your library' })).toHaveCount(0);
    await expect(page.getByText('Loading your library', { exact: true })).toHaveCount(0);
  });
}

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
      await routeTmdb(page, async (route) => {
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
      await page.goto(`${E2E_ORIGIN}/test/library.html?populated`);
      await expect.poll(() => requested.size).toBe(4);
      const pending = page.locator('[data-pending-shelf]');
      await expect(pending).toHaveCount(2);
      await expect(pending.locator('.skeleton')).toHaveCount(12);
      const pendingGeometry = await pending.locator('section.row').evaluateAll((rows) =>
        Object.fromEntries(
          rows.map((row) => [
            row.getAttribute('aria-label'),
            {
              top: row.getBoundingClientRect().top + scrollY,
              height: row.getBoundingClientRect().height,
            },
          ]),
        ),
      );
      gates.get(1001).release();
      gates.get(1005).release();
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
      await expect(pending).toHaveCount(0);
      const settledLabels = failed ? ['Watchlist'] : ['Continue Watching', 'Watchlist'];
      for (const label of settledLabels) {
        const settled = await page
          .getByRole('region', { name: label, exact: true })
          .evaluate((row) => ({
            top: row.getBoundingClientRect().top + scrollY,
            height: row.getBoundingClientRect().height,
          }));
        expect(settled.height).toBeCloseTo(pendingGeometry[label].height, 1);
        // A failed earlier shelf is deliberately removed; the later shelf then closes that reserved gap.
        if (!failed) expect(settled.top).toBeCloseTo(pendingGeometry[label].top, 1);
      }
      const positions = () =>
        page.locator('section.row').evaluateAll(
          (rows, labels) =>
            rows
              .filter((row) => labels.includes(row.getAttribute('aria-label')))
              .map((row) => ({
                label: row.getAttribute('aria-label'),
                top: row.getBoundingClientRect().top + scrollY,
              })),
          settledLabels,
        );
      const before = await positions();
      await page.waitForTimeout(250);
      // Labels exactly, positions to the same tolerance the shift metric below allows. Exact float
      // equality failed about one run in three at this width, on a difference of 0.031px — a
      // thirty-second of a pixel, sub-pixel rounding as the last shelf resolves, and comfortably
      // inside the 0.05 this test already calls settled. A shelf moving under a reader is what this
      // is about, and that is what both assertions now measure.
      // Browse rows below use content-visibility and may report a temporary zero rect while skipped, so compare
      // only the named shelves whose stability this test owns.
      const after = (await positions()).slice(0, before.length);
      expect(after.map((row) => row.label)).toEqual(before.map((row) => row.label));
      for (const [at, row] of after.entries()) expect(row.top).toBeCloseTo(before[at].top, 1);
      const shifts = await page.evaluate(() => window.shifts.reduce((a, b) => a + b, 0));
      expect(shifts).toBeLessThan(0.05);
      expect(requested.has(1003), 'watched history should stay dormant on Home').toBe(false);
    } finally {
      await browser.close();
    }
  });
}

test('Downloading waits for exact shelf order when Continue Watching membership needs a TV shape', async ({
  browser,
}) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 852 },
    reducedMotion: 'reduce',
  });
  await guardNetwork(page);
  let releaseShape;
  const shapeGate = new Promise((resolve) => (releaseShape = resolve));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, async (route) => {
    const url = new URL(route.request().url());
    const [, type, rawId] = url.pathname.match(/\/(movie|tv)\/(\d+)$/) ?? [];
    const id = Number(rawId);
    if (type === 'tv' && id === 2002) await shapeGate;
    const details = {
      id,
      ...(type === 'tv' ? { name: `Series ${id}` } : { title: `Movie ${id}` }),
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      release_date: '2026-01-01',
      first_air_date: '2026-01-01',
      vote_average: 7.5,
      vote_count: 500,
      genre_ids: [18],
      ...(type === 'tv'
        ? {
            seasons: [{ season_number: 1, episode_count: 3 }],
            last_episode_to_air: { season_number: 1, episode_number: 3 },
          }
        : {}),
    };
    await route.fulfill({
      json: rawId
        ? details
        : {
            page: 1,
            total_pages: 1,
            results: Array.from({ length: 12 }, (_, index) => ({
              ...details,
              id: index + 1,
              title: `Movie ${index + 1}`,
            })),
          },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );

  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&series-continue&downloading&no-movie-continue&continue-hint`,
  );
  // Until Continue is either reserved or proven absent, every lower Home row stays out of the document.
  await expect(page.getByRole('region', { name: 'Continue Watching', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Watchlist', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Downloading', exact: true })).toHaveCount(0);

  await page.evaluate(() => window.denTestReleaseContinueHint());
  // The encrypted last-known positive reserves geometry only: Watchlist may now follow that placeholder, while
  // real Download cards still wait for the current shelf contents.
  await expect(page.getByRole('region', { name: 'Continue Watching', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Watchlist', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Downloading', exact: true })).toHaveCount(0);

  releaseShape();
  const continued = page.getByRole('region', { name: 'Continue Watching', exact: true });
  const downloading = page.getByRole('region', { name: 'Downloading', exact: true });
  await expect(continued).toBeVisible();
  await expect(downloading).toBeVisible();
  expect(await continued.evaluate((row) => row.getBoundingClientRect().top)).toBeLessThan(
    await downloading.evaluate((row) => row.getBoundingClientRect().top),
  );
  await page.close();
});

test('large Home shelves publish and extend in viewport-sized tranches', async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 852 },
    reducedMotion: 'reduce',
  });
  await guardNetwork(page);
  const details = new Set();
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/movie\/(\d+)$/);
    const id = Number(match?.[1]);
    const movie = (movieId) => ({
      id: movieId,
      title: `Movie ${movieId}`,
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
      release_date: '2026-01-01',
      vote_average: 7.5,
      vote_count: 500,
      genre_ids: [18],
    });
    if (id >= 1000) details.add(id);
    await route.fulfill({
      json: id
        ? movie(id)
        : {
            page: 1,
            total_pages: 1,
            results: Array.from({ length: 12 }, (_, index) => movie(index + 1)),
          },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );

  await page.goto(`${E2E_ORIGIN}/test/library.html?populated&many=24&unnamed-many`);
  const row = page.getByRole('region', { name: 'Continue Watching', exact: true });
  await expect(row.locator('[data-card-index]')).toHaveCount(8);
  // Eight continued titles, one saved title and the two newest watched recommendation seeds. The other sixteen
  // continued titles stay out of Svelte's first shelf publication.
  await expect.poll(() => details.size).toBe(11);

  // Slots precede the virtual window's effect. A mounted card proves its passive scroll listener and width
  // observer are ready before this faster-than-human synthetic scroll.
  await expect(row.locator('[data-card-index="0"] .card')).toBeVisible();
  await row.locator('.track').evaluate((track) => {
    track.scrollLeft = track.scrollWidth;
    track.dispatchEvent(new Event('scroll'));
  });
  await expect(row.locator('[data-card-index]')).toHaveCount(16);
  await expect.poll(() => details.size).toBe(19);
  expect(
    await row
      .locator('[data-card-index]')
      .evaluateAll((slots) =>
        slots.map((slot) =>
          Number(/\/movie\/(\d+)/.exec(slot.querySelector('a')?.getAttribute('href') ?? '')?.[1]),
        ),
      ),
  ).toEqual(Array.from({ length: 16 }, (_, index) => 3023 - index));

  // Focusing near the named edge admits the following tranche before Tab can leave the shelf.
  // Native focus may also scroll the track. If that scroll lands after the tranche is published, it is a
  // second valid intent and admits the final one-title tail; keep both outcomes bounded.
  await row.locator('[data-card-index="14"] a').focus();
  await expect.poll(() => row.locator('[data-card-index]').count()).toBeGreaterThanOrEqual(24);
  expect(await row.locator('[data-card-index]').count()).toBeLessThanOrEqual(25);
  await expect.poll(() => details.size).toBeGreaterThanOrEqual(27);
  expect(details.size).toBeLessThanOrEqual(28);
  await page.close();
});
