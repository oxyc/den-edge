import { test, expect } from '@playwright/test';

const unexpected = [];
test.beforeEach(() => { unexpected.length = 0; });
test.afterEach(() => { expect(unexpected, 'all API/external requests must be mocked').toEqual([]); });

export async function guardNetwork(page) {
  // Page-specific fixture mocks take precedence over this context-level fallback.
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:5198' && url.pathname === '/atlas/manifest.json') return route.fulfill({status:404,body:'Fixture catalogue unavailable'});
    const source = /^\/(?:test\/|src\/|@|node_modules\/|favicon\.ico)/.test(url.pathname);
    if (url.origin === 'http://127.0.0.1:5198' && source) return route.continue();
    unexpected.push(route.request().method() + ' ' + url.origin + url.pathname);
    return route.abort('blockedbyclient');
  });
}
