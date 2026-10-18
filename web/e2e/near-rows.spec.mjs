import { existsSync } from 'node:fs';
import { chromium, expect, test, webkit } from '@playwright/test';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

// A row below the screen but inside its near window must have its posters before the viewer reaches it. Rows skip
// their content with `content-visibility: auto`; WebKit never laid out a skipped row's track, so its cards waited for
// the row to scroll on screen (or a tap to force layout). Chromium delivered the track's size regardless, which is why
// both engines run here.
const ENGINES = [
  ['WebKit', webkit],
  ['Chromium', chromium],
];

async function open(engine, path) {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await guardNetwork(page);
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>',
    }),
  );
  await page.goto(`${E2E_ORIGIN}${path}`);
  return { browser, page };
}

/** Posters that finished loading in each row, with the row's top relative to the viewport. */
const rowPosters = (page, selector) =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((row) => ({
        top: Math.round(row.getBoundingClientRect().top),
        loaded: [...row.querySelectorAll('img')].filter(
          (img) => img.complete && img.naturalWidth > 0,
        ).length,
      })),
    selector,
  );

for (const [name, engine] of ENGINES) {
  test.describe(name, () => {
    test.skip(
      !process.env.CI && !existsSync(engine.executablePath()),
      `needs ${name}: npx playwright install`,
    );

    test('browse rows inside the near window load posters without a scroll or tap', async () => {
      const { browser, page } = await open(engine, '/test/browse-window.html?catalog');
      try {
        const viewport = page.viewportSize().height;
        // BrowseRow's near window reaches 800px below the screen.
        const near = (rows) => rows.filter((r) => r.top >= viewport && r.top < viewport + 800);
        await expect
          .poll(async () => near(await rowPosters(page, '.row-window')).map((r) => r.loaded))
          .toEqual([3, 3]);
        const rows = await rowPosters(page, '.row-window');
        expect(
          rows.filter((r) => r.top >= viewport + 800).every((r) => r.loaded === 0),
          'rows past the near window still draw nothing',
        ).toBe(true);
        expect(await page.evaluate(() => scrollY)).toBe(0);
      } finally {
        await browser.close();
      }
    });

    test('a windowed shelf below the screen loads its posters without a scroll or tap', async () => {
      const { browser, page } = await open(engine, '/test/windowed-navigation.html?below');
      try {
        const [shelf] = await rowPosters(page, '.windowed');
        expect(shelf.top).toBeGreaterThan(page.viewportSize().height);
        await expect
          .poll(async () => (await rowPosters(page, '.windowed'))[0].loaded)
          .toBeGreaterThan(0);
        expect(await page.evaluate(() => scrollY)).toBe(0);
      } finally {
        await browser.close();
      }
    });
  });
}
