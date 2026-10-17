// A profile household opens two libraries as the page loads (the household's and the Owner's), one library Worker
// each. Through the real app and an in-memory den-edge, a load downloads den-core's wasm once and asks /routes and
// /capabilities/profiles once, however many sessions want them.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

// The Worker script itself is not counted: each library has a Worker of its own by design (one LibraryLog per
// Worker), and the browser's HTTP cache gives the second the first's transfer of that immutable asset. Request
// interception, which these specs use, turns that cache off, so here it would always read as two.
const kinds = {
  wasm: (url) => url.pathname.endsWith('/den_core_bg.wasm'),
  routes: (url) => url.pathname === '/routes',
  profiles: (url) => url.pathname === '/capabilities/profiles',
};

/** Load `path` and count what it fetches until the profile switcher is up and three seconds have been quiet. */
async function countedLoad(page, path) {
  const seen = Object.fromEntries(Object.keys(kinds).map((kind) => [kind, []]));
  const count = (request) => {
    const url = new URL(request.url());
    for (const [kind, matches] of Object.entries(kinds))
      if (matches(url)) seen[kind].push(`${request.method()} ${url.pathname}`);
  };
  page.context().on('request', count);
  await page.goto(`${E2E_ORIGIN}${path}`);
  await expect(page.getByRole('button', { name: 'Switch profile, current Owner' })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(3_000);
  page.context().off('request', count);
  return seen;
}

const countsOf = (seen) =>
  Object.fromEntries(Object.entries(seen).map(([kind, list]) => [kind, list.length]));

test('a profile household’s load downloads den-core once and asks each startup question once', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const edge = newEdge({ profiles: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    await routeGuestEdge(page, edge);
    // den-edge's table names its services; an empty one is den-edge not saying, which a page asks again.
    await page.route('**/routes', (route) =>
      route.fulfill({ json: { addons: { reel: [{ url: `${E2E_ORIGIN}/reel` }] } } }),
    );
    // A profile household of the browser's own: a guest's, started by accepting an invite, with a title saved.
    await page.goto(`${E2E_ORIGIN}/`);
    await page.getByRole('button', { name: 'Look around instead' }).click();
    await page.goto(`${E2E_ORIGIN}/movie/1002`);
    const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.click();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
    await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
    await page
      .getByRole('dialog', { name: 'Accept this invite?' })
      .getByRole('button', { name: 'Accept' })
      .click();
    await expect(page.getByRole('button', { name: 'Switch profile, current Owner' })).toBeVisible({
      timeout: 30_000,
    });

    const home = await countedLoad(page, '/');
    expect(countsOf(home), JSON.stringify(home)).toEqual({ wasm: 1, routes: 1, profiles: 1 });
    // Settings asks /routes of its own as it opens, beside the session's.
    const settings = await countedLoad(page, '/settings');
    expect(countsOf(settings), JSON.stringify(settings)).toEqual({
      wasm: 1,
      routes: 1,
      profiles: 1,
    });

    // Both Workers run den-core from the page's one compile: the Owner's library still reads and shows what it holds.
    await page.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(page.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await browser.close();
  }
});
