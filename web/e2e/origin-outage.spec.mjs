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
        // Two pages, and an empty third: the row's end.
        titles: (
          { 0: [0, 1, 2], 24: [3, 4, 5] }[
            Number(new URL(route.request().url()).searchParams.get('skip'))
          ] ?? []
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
  page.getByRole('alert').filter({ hasText: 'Den’s server can’t be reached' });

/** The origin answering again: no routes table, atlas with no people, and TMDB with nothing to say. */
async function originBack(page) {
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/atlas/manifest.json', (route) =>
    route.fulfill({ json: { id: 'com.den.atlas', catalogs: [] } }),
  );
  await page.route('**/atlas/index/**', (route) =>
    route.fulfill({ json: { people: [], total: 0, labels: {}, values: [], complete: true } }),
  );
  await page.route('**/tmdb/3/**', (route) => route.fulfill({ json: { results: [] } }));
}

const unreachable = (page) =>
  page.getByRole('alert').filter({ hasText: 'Den’s server can’t be reached right now.' });
/** People's own controls, drawn only once atlas is configured. */
const peopleRail = (page) => page.getByRole('textbox', { name: 'Born from (year)' });
/** In-app navigation, as a link does it: the same page, no reload. */
const go = (page, path) =>
  page.evaluate(
    (to) => document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path: to } })),
    path,
  );
/** A browser with no library looks around as a visitor, then opens People. */
async function visitPeople(page) {
  await page.goto(`${E2E_ORIGIN}/`);
  const asked = page.waitForResponse((response) => response.url().includes('/tmdb/3/'), {
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Look around instead' }).click({ timeout: 60_000 });
  // Home's rows ask TMDB through den-edge before People is opened.
  await asked;
  await go(page, '/people');
}

test('a visitor with nothing saved is told the server is down, and People comes back by itself', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    const restore = await originDown(page);
    // Home first, as a visitor opens Den: its TMDB rows fail with nothing saved.
    await visitPeople(page);
    // An answer with a way out, not a load that never ends.
    await expect(unreachable(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('section.people')).toHaveAttribute('aria-busy', 'false');

    // Retry while it is still down asks again, and says the same.
    await unreachable(page).getByRole('button', { name: 'Try again' }).click();
    await expect(unreachable(page)).toBeVisible({ timeout: 60_000 });

    // The server is back. Without Retry or a reload, its next answer (Home's TMDB rows) finds atlas again.
    await restore();
    await originBack(page);
    const answered = page.waitForResponse(
      (response) => response.url().includes('/tmdb/3/') && response.ok(),
      { timeout: 60_000 },
    );
    await go(page, '/');
    await answered;
    await go(page, '/people');
    await expect(peopleRail(page)).toBeVisible({ timeout: 60_000 });
    await expect(unreachable(page)).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

test('a visitor’s Retry finds atlas once the server is back', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    const restore = await originDown(page);
    await visitPeople(page);
    await expect(unreachable(page)).toBeVisible({ timeout: 60_000 });
    await restore();
    await originBack(page);
    await unreachable(page).getByRole('button', { name: 'Try again' }).click();
    await expect(peopleRail(page)).toBeVisible({ timeout: 60_000 });
  } finally {
    await browser.close();
  }
});

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
    // Its second page, asked at once since the row's end is in reach.
    await expect(atlasRow(healthy).getByRole('link', { name: `Film ${ROW_FILM + 3}` })).toBeVisible(
      {
        timeout: 60_000,
      },
    );
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
    // The row's pages are the kept ones, through to its end: nothing in it says it couldn't load.
    await expect(atlasRow(page).getByRole('link', { name: `Film ${ROW_FILM}` })).toBeVisible({
      timeout: 60_000,
    });
    await expect(atlasRow(page).getByRole('link', { name: `Film ${ROW_FILM + 3}` })).toBeVisible({
      timeout: 60_000,
    });
    await expect(atlasRow(page).getByRole('button', { name: /Couldn’t load these/ })).toHaveCount(
      0,
    );
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
