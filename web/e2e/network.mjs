import { test, expect } from '@playwright/test';

const unexpected = [];
test.beforeEach(() => {
  unexpected.length = 0;
});
test.afterEach(() => {
  expect(unexpected, 'all API/external requests must be mocked').toEqual([]);
});

/**
 * TMDB, however the app asks for it.
 *
 * Every browser now asks THIS origin — `/tmdb/3/…` — so that one cache answers every device and visitor, and
 * the key never leaves den-edge (`tmdbCache.ts`). A fixture that mocks only `api.themoviedb.org` therefore
 * mocks nothing the app requests, and the guard below reports the real calls as unmocked. Both shapes are
 * registered so a spec keeps saying what it means: "when the app asks TMDB, answer this".
 */
export async function routeTmdb(page, handler) {
  await page.route('https://api.themoviedb.org/**', handler);
  await page.route('**/tmdb/3/**', handler);
}

export async function guardNetwork(page) {
  // Page-specific fixture mocks take precedence over this context-level fallback.
  await page.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    // The app asks this origin whether it serves atlas or reel itself, when the library lists neither as a
    // plugin — a guest lists nothing at all, and both have a same-origin fallback (findAtlas, findReel).
    // A 404 is what "not served here" looks like, which is what a fixture is.
    const probe =
      url.pathname === '/atlas/manifest.json' ||
      url.pathname === '/reel/manifest.json' ||
      url.pathname === '/remux/health';
    if (url.origin === 'http://127.0.0.1:5198' && probe)
      return route.fulfill({ status: 404, body: 'Fixture catalogue unavailable' });
    // Every detail page asks den-edge for the title's ratings and content warnings, key or not. Unless a spec says
    // otherwise, den-edge keeps nothing for a fixture title and nobody here may look one up.
    const kept = /^\/(?:ratings|warnings)\/imdb\//.test(url.pathname);
    if (url.origin === 'http://127.0.0.1:5198' && kept)
      return route.fulfill({ status: 404, json: { error: 'not_cached' } });
    const source = /^\/(?:test\/|src\/|@|node_modules\/|favicon\.ico)/.test(url.pathname);
    if (url.origin === 'http://127.0.0.1:5198' && source) return route.continue();
    unexpected.push(route.request().method() + ' ' + url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
}
