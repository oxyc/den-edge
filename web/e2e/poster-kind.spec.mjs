import { chromium, expect, test, webkit } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

/** The season layout the stand-in TMDB gives each library series: Series 2004 has one season, Series 2005 four. */
const LAYOUTS = { 2004: [12], 2005: [8, 10, 6, 9] };

/**
 * Home at phone width on a library whose watchlist holds a film and two series, under a stand-in TMDB whose lists carry one
 * series the library does not hold. TMDB's list answers have no season counts, so that one says only "Series".
 *
 * With `atlas`, atlas is there too, and its "New on Netflix" charts lead New Releases with what just landed on
 * Netflix: Series 2005 (held, so its layout is known), a series the library does not hold, and a film.
 */
async function openHome(browser, { atlas = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await guardNetwork(page);
  await page.route('**/routes', (r) => r.fulfill({ json: {} }));
  if (atlas) {
    await page.route('**/atlas/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/atlas/manifest.json'))
        return route.fulfill({
          json: {
            id: 'com.den.atlas',
            catalogs: [
              { type: 'movie', id: 'jw-nfx-new', name: 'New on Netflix', denProviderIds: [8] },
              {
                type: 'series',
                id: 'jw-nfx-series-new',
                name: 'New series on Netflix',
                denProviderIds: [8],
              },
            ],
          },
        });
      const chart = /\/catalog\/\w+\/(jw-nfx-new|jw-nfx-series-new)\//.exec(path)?.[1];
      if (chart) {
        const metas =
          chart === 'jw-nfx-new'
            ? [{ type: 'movie', moviedb_id: 7102, name: 'Charted movie' }]
            : [
                { type: 'series', moviedb_id: 2005, name: 'Series 2005' },
                { type: 'series', moviedb_id: 7101, name: 'Charted series' },
              ];
        return route.fulfill({
          json: {
            metas: metas.map((meta) => ({
              ...meta,
              posterPath: '/poster.jpg',
              releaseInfo: '2019',
            })),
          },
        });
      }
      if (path.includes('/catalog/')) return route.fulfill({ json: { metas: [] } });
      if (path.includes('/recommend')) return route.fulfill({ json: { version: 1, slides: [] } });
      if (path.includes('/index/suggest'))
        return route.fulfill({ json: { perSeed: [], pooled: [] } });
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    });
    await page.route('**/metadata/title/query', (r) => r.fulfill({ json: { entries: [] } }));
    await page.route('**/metadata/title', (r) => r.fulfill({ status: 204 }));
  }
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/watch/providers/'))
      return route.fulfill({
        json: {
          results: [
            { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 },
          ],
        },
      });
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
    const charted = { 7101: 'Charted series', 7102: 'Charted movie' }[id];
    return route.fulfill({
      json: {
        id: Number(id),
        ...(type === 'movie'
          ? { title: charted ?? `Movie ${id}`, release_date: '2019-01-01' }
          : {
              name: charted ?? `Series ${id}`,
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
  await page.goto(
    `${E2E_ORIGIN}/test/library.html?populated&series-kinds${atlas ? '&services' : ''}`,
  );
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
      const recommendation = films.locator('h2 .heading-link');
      await recommendation.focus();
      const ring = await recommendation.evaluate((node) => {
        const heading = node.closest('h2').getBoundingClientRect();
        const link = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          offset: style.outlineOffset,
          ringRight: link.right + parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset),
          clipRight: heading.right,
        };
      });
      expect(ring.offset).toBe('-3px');
      expect(ring.ringRight).toBeLessThanOrEqual(ring.clipRight + 0.5);
      await reveal(row);
      await expect(row.locator('.caption')).toHaveText(['2019 · Series']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${name}-rows.png`) });
    } finally {
      await browser.close();
    }
  });

  test(`a card named by its service still tells a series from a film at phone width in ${name}`, async () => {
    const browser = await engine.launch(
      engine === chromium
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {},
    );
    try {
      const page = await openHome(browser, { atlas: true });
      // The services' names come from their directory, asked for as the Services rail nears the screen: scrolled
      // past on the way down, as a viewer would.
      const services = page.getByRole('region', { name: 'Services', exact: true });
      await services.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      const netflix = services.getByRole('link', { name: 'Netflix' });
      await expect(netflix).toBeVisible();
      await netflix.focus();
      await expect(netflix).toHaveCSS('outline-style', 'none');
      await expect(netflix.locator('.art')).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
      await expect(netflix.locator('.art')).toHaveCSS('outline-width', '3px');
      // What just landed on Netflix leads New Releases, each card named by the service in place of its year.
      const row = page.getByRole('region', { name: 'New Releases', exact: true });
      const line = (title) =>
        row
          .locator('a.card', { has: page.locator('.name', { hasText: title }) })
          .locator('.caption');
      // Rows above it settle as they load, so it is brought back on screen until its cards mount.
      await expect(async () => {
        await row.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await expect(line('Charted movie')).toBeAttached({ timeout: 500 });
      }).toPass();
      // A film stays "Netflix"; a series says it is one, with its seasons where the library holds its layout.
      await expect(line('Charted movie')).toHaveText('Netflix');
      await expect(line('Series 2005')).toHaveText('Netflix · 4 seasons');
      await expect(line('Charted series')).toHaveText('Netflix · Series');
      // A TMDB title in the same row has no service and keeps its year line.
      await expect(line('Unheld movie')).toHaveText('2019');

      const fits = await line('Series 2005').evaluate((node) => ({
        overflow: getComputedStyle(node).textOverflow,
        lines: Math.round(
          node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight),
        ),
      }));
      expect(fits).toEqual({ overflow: 'ellipsis', lines: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.screenshot({ path: test.info().outputPath(`poster-kind-${name}-service.png`) });
    } finally {
      await browser.close();
    }
  });
}
