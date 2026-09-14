import { test, expect } from '@playwright/test';

const unexpected = [];
test.beforeEach(() => {
  unexpected.length = 0;
});
test.afterEach(() => {
  expect(unexpected, 'all API/external requests must be mocked').toEqual([]);
});

export async function guardNetwork(page) {
  // Page-specific fixture mocks take precedence over this context-level fallback.
  await page.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    // The app asks this origin whether it serves atlas or reel itself, when the library lists neither as a
    // plugin — a guest lists nothing at all, and both have a same-origin fallback (findAtlas, findReel).
    // A 404 is what "not served here" looks like, which is what a fixture is.
    const probe = url.pathname === '/atlas/manifest.json' || url.pathname === '/reel/manifest.json';
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
