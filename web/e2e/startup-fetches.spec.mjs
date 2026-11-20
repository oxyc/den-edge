// A profile household opens two libraries as the page loads (the household's and the Owner's), one library Worker
// each. Through the real app and an in-memory den-edge, a load downloads den-core's wasm once and asks /routes and
// /capabilities/profiles once, however many sessions want them.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold } from './big-library.mjs';

// The Worker script itself is not counted: each library has a Worker of its own by design (one LibraryLog per
// Worker), and the browser's HTTP cache gives the second the first's transfer of that immutable asset. Request
// interception, which these specs use, turns that cache off, so here it would always read as two.
// The dev server names den-core's wasm `den_core_startup_bg.wasm`; a build, `den_core_startup_bg-<hash>.wasm`.
const kinds = {
  startupWasm: (url) => /\/den_core_startup_bg(?:-[\w-]+)?\.wasm$/.test(url.pathname),
  deferredWasm: (url) => /\/den_core_deferred_bg(?:-[\w-]+)?\.wasm$/.test(url.pathname),
  routes: (url) => url.pathname === '/routes',
  profiles: (url) => url.pathname === '/capabilities/profiles',
};

/**
 * Load `path` and count what it fetches: once the profile switcher is up and every kind has been fetched (the deferred
 * den-core compile starts after first paint, later on a busy machine), three more seconds catch any second fetch.
 */
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
  await expect
    .poll(() => Object.values(seen).every((list) => list.length > 0), { timeout: 30_000 })
    .toBe(true);
  await page.waitForTimeout(3_000);
  page.context().off('request', count);
  return seen;
}

const countsOf = (seen) =>
  Object.fromEntries(Object.entries(seen).map(([kind, list]) => [kind, list.length]));

// RoutedLibrary, Library and the Home screen's own components, which pull in the library service: by file name in the
// dev server's modules and by chunk name in the build.
const LIBRARY = /\/(?:RoutedLibrary|routed-library|Library|Billboard|PosterCard)[-.]/;

test('a paired start asks for the library beside the app module, not after it runs', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.addInitScript(() =>
    localStorage.setItem(
      'den.links',
      JSON.stringify([
        { inboxKey: '0123456789abcdef', libraryKey: 'fixture-library', linkKey: 'fixture-link' },
      ]),
    ),
  );
  // One timeline: the library's request against the moment the app module starts to run (`startupMark`).
  const timeline = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (LIBRARY.test(pathname)) timeline.push('library requested');
  });
  page.on('console', (message) => {
    if (message.text().includes('app module evaluated')) timeline.push('app module evaluated');
  });
  await page.goto(E2E_ORIGIN);
  await expect
    .poll(() => timeline.includes('app module evaluated'), { timeout: 30_000 })
    .toBe(true);
  expect(timeline[0]).toBe('library requested');
});

test('an unpaired start loads the pairing screen without the paired library’s graph', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  const library = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (LIBRARY.test(pathname)) library.push(pathname);
  });
  await page.goto(E2E_ORIGIN);
  await expect(page.getByLabel('Link code, twelve characters')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  expect(library).toEqual([]);

  // Choosing to look around is the same decision turned the other way: now the library is wanted.
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect.poll(() => library.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

test('a profile household’s load downloads den-core once and asks each startup question once', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    test.setTimeout(240_000);
    const edge = newEdge({ profiles: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    // A profile household of the browser's own, the size of a long-lived one: a guest's, started by accepting an
    // invite with a big library kept in this browser (`big-library.mjs`).
    await bigHousehold(context, edge, { atlas: false });
    const page = await context.newPage();
    await routeBigHousehold(page, edge, { atlas: false });
    // den-edge's table names its services; an empty one is den-edge not saying, which a page asks again.
    await page.route('**/routes', (route) =>
      route.fulfill({ json: { addons: { reel: [{ url: `${E2E_ORIGIN}/reel` }] } } }),
    );

    const home = await countedLoad(page, '/');
    expect(countsOf(home), JSON.stringify(home)).toEqual({
      startupWasm: 1,
      deferredWasm: 1,
      routes: 1,
      profiles: 1,
    });
    // Settings asks /routes of its own as it opens, beside the session's.
    const settings = await countedLoad(page, '/settings');
    expect(countsOf(settings), JSON.stringify(settings)).toEqual({
      startupWasm: 1,
      deferredWasm: 1,
      routes: 1,
      profiles: 1,
    });

    // Both Workers run den-core from the page's one compile: the Owner's library still reads and shows what it holds.
    await page.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(page.getByRole('link', { name: /Film 100000/ }).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await browser.close();
  }
});
