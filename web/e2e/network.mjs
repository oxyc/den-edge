import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

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

/** `origin` is where the page is served from: the dev server's address, or a name a spec points at it. */
export async function guardNetwork(page, origin = E2E_ORIGIN) {
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
    if (url.origin === origin && probe)
      return route.fulfill({ status: 404, body: 'Fixture catalogue unavailable' });
    // Every detail page asks den-edge for the title's ratings and content warnings, key or not. Unless a spec says
    // otherwise, den-edge keeps nothing for a fixture title and nobody here may look one up.
    const kept = /^\/(?:ratings|warnings)\/imdb\//.test(url.pathname);
    if (url.origin === origin && kept)
      return route.fulfill({ status: 404, json: { error: 'not_cached' } });
    // A title's You might also like asks for atlas's paged cards first. Unless a spec mocks them, the fixture's atlas
    // predates that route, and the row goes on from the POST it mocks (`relatedRows.ts`).
    // So does its page's /index/title, for the companies and networks it links: the page then shows them as text.
    // And /index/franchise and /index/versions: the page then shows TMDB's collection, and no other versions.
    const cards =
      /\/index\/(?:suggest|title|franchise|versions)\/(?:movie|series)\/\d+\.json$/.test(
        url.pathname,
      );
    if (url.origin === origin && cards)
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    // A library's recovery codes are checked at launch and when Settings opens (`recovery.ts`): none, unless a spec
    // says otherwise.
    if (url.origin === 'http://127.0.0.1:5198' && url.pathname === '/recovery')
      return route.fulfill({ json: { entries: [] } });
    // Opening search asks den-edge to open its TMDB connection ahead of the lookups (`warmTmdb`); it answers nothing.
    if (url.origin === origin && url.pathname === '/tmdb/warm')
      return route.fulfill({ status: 204 });
    const source = /^\/(?:test\/|src\/|@|node_modules\/|favicon\.ico)/.test(url.pathname);
    if (url.origin === origin && source) return route.continue();
    unexpected.push(route.request().method() + ' ' + url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
}
