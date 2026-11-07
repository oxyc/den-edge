// Friends and family open Den Web from away from home. When the box or its uplink is down, Cloudflare answers what it
// holds a copy of (the shell, by `stale-if-error`) and its own 52x page for everything else, its copies often evicted
// by then. A returning household's Home must open from what this browser kept — its library, the billboard, TMDB's
// answers and atlas's rows — say truthfully that it is a saved copy, and drop the notice once the server answers again.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold } from './big-library.mjs';

/** Home's first atlas row (`atlasRows.ts`), which atlas fills with films nobody in the household has seen. */
const ROW = 'Mind-Bending';
const ROW_FILM = 600_001;

/** den-edge's routes table, which names atlas, and atlas's browse rows, each a page of films of its own. */
async function routeAtlasRows(page) {
  await page.route('**/routes', (route) =>
    route.fulfill({ json: { addons: { atlas: [{ url: `${E2E_ORIGIN}/atlas` }] } } }),
  );
  await page.route('**/atlas/index/row/*.json*', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'public, max-age=300' },
      json: {
        // One page: a later one is the row's end.
        titles: (new URL(route.request().url()).searchParams.get('skip') === '0'
          ? [0, 1, 2]
          : []
        ).map((i) => ({
          type: 'movie',
          id: ROW_FILM + i,
          title: `Film ${ROW_FILM + i}`,
          year: 2020,
          posterPath: `/poster-${ROW_FILM + i}.jpg`,
        })),
      },
    }),
  );
}

/** The origin down behind Cloudflare: the shell and its hashed files are Cloudflare's copies; every call is a 522. */
async function originDown(page) {
  const down = (route) => {
    const path = new URL(route.request().url()).pathname;
    const shell =
      path === '/' || /^\/assets\//.test(path) || /\.(?:js|css|wasm|svg|png|ico|woff2)$/.test(path);
    return shell
      ? route.fallback()
      : route.fulfill({ status: 522, contentType: 'text/html', body: '<html>522</html>' });
  };
  await page.route(`${E2E_ORIGIN}/**`, down);
  return () => page.unroute(`${E2E_ORIGIN}/**`, down);
}

const atlasRow = (page) =>
  page.locator('section.row').filter({ has: page.getByRole('heading', { name: ROW }) });

/** Scroll Home down until its atlas row is drawn: Home publishes its shelves a viewport at a time. */
async function scrollToAtlasRow(page) {
  await expect(page.locator('main').getByText('Continue Watching').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(
      async () => {
        if (await atlasRow(page).count()) return true;
        await page.mouse.wheel(0, 900);
        return false;
      },
      { timeout: 60_000, intervals: [300] },
    )
    .toBe(true);
  await atlasRow(page).scrollIntoViewIfNeeded();
}
const keptNotice = (page) =>
  page.getByRole('status').filter({ hasText: 'Den’s server can’t be reached right now' });

test('a returning household opens Home from what it kept while the origin is down, and says so', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    test.setTimeout(420_000);
    const edge = newEdge({ profiles: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    await bigHousehold(context, edge);

    // A visit while the server answers: Home's atlas row is drawn, and kept.
    const healthy = await context.newPage();
    await routeBigHousehold(healthy, edge);
    await routeAtlasRows(healthy);
    await healthy.goto(`${E2E_ORIGIN}/`);
    await scrollToAtlasRow(healthy);
    await expect(atlasRow(healthy).getByRole('link', { name: `Film ${ROW_FILM}` })).toBeVisible({
      timeout: 60_000,
    });
    await expect(keptNotice(healthy)).toHaveCount(0);
    // The kept answer's write is gathered for a moment (`indexedKept`), and the services found are retained a second
    // after they settle (`SessionServices`).
    await healthy.waitForTimeout(2_500);
    await healthy.close();

    // The next visit, with the origin down.
    const page = await context.newPage();
    await routeBigHousehold(page, edge);
    await routeAtlasRows(page);
    const restore = await originDown(page);
    await page.goto(`${E2E_ORIGIN}/`);
    await scrollToAtlasRow(page);
    // The row's first page is the kept one; only where it would page on does it say it couldn't.
    await expect(atlasRow(page).getByRole('link', { name: `Film ${ROW_FILM}` })).toBeVisible({
      timeout: 60_000,
    });
    await expect(keptNotice(page)).toBeVisible();
    await expect(page.getByText('Profiles couldn’t be opened')).toHaveCount(0);

    // The server answers again: the next screen's atlas rows come live, and the notice goes without a reload.
    await restore();
    await page.getByRole('link', { name: 'Movies' }).first().click();
    await expect(keptNotice(page)).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await browser.close();
  }
});
