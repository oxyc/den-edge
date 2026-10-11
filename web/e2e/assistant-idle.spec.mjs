import { test, expect, chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { E2E_ORIGIN } from './base-url.mjs';

/**
 * A member's library with no assistant connection, open in the real app over an empty den-edge: the page must do no
 * assistant work at all — no drain, no renewal, no projection — and never fetch the assistant code.
 */
test('a library with no assistant connection makes no assistant request and loads no assistant code', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const b64 = () => randomBytes(32).toString('base64');
    const link = {
      inboxKey: randomBytes(16).toString('hex'),
      libraryKey: b64(),
      linkKey: b64(),
      recovered: true,
    };
    await context.addInitScript(
      (links) => {
        if (!localStorage.getItem('den.links')) localStorage.setItem('den.links', links);
      },
      JSON.stringify([link]),
    );
    const assistant = [];
    let synced = 0;
    const headers = { 'x-den-generation': 'idle', 'x-den-wire-min': '4' };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== E2E_ORIGIN) return route.abort('blockedbyclient');
      if (/^\/(?:src\/|@|node_modules\/)/.test(url.pathname) || url.pathname === '/') {
        if (url.pathname.startsWith('/src/lib/assistant.ts')) assistant.push(url.pathname);
        return route.continue();
      }
      if (url.pathname.startsWith('/assistant/') || url.pathname.startsWith('/oauth/'))
        assistant.push(`${request.method()} ${url.pathname}`);
      if (url.pathname.startsWith('/lib/')) {
        if (url.pathname.endsWith('/changes')) {
          synced++;
          return route.fulfill({
            headers,
            json: { generation: 'idle', entries: [], head: 0, more: false },
          });
        }
        if (url.pathname.endsWith('/batch')) {
          const body = request.postDataJSON();
          return route.fulfill({
            headers,
            json: { applied: body.writes.map((w, i) => ({ k: w.k, seq: i + 1 })), conflicts: [] },
          });
        }
        return route.fulfill({ headers, json: {} });
      }
      if (url.pathname === '/recovery') return route.fulfill({ json: { entries: [] } });
      if (['/routes', '/config', '/version'].includes(url.pathname))
        return route.fulfill({ json: {} });
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    });
    const page = await context.newPage();
    await page.goto(`${E2E_ORIGIN}/`);
    // The library has opened and synced: whatever the page would start for assistants, it has had time to.
    await expect.poll(() => synced, { timeout: 20_000 }).toBeGreaterThan(1);
    await page.waitForTimeout(3_000);
    expect(assistant).toEqual([]);
  } finally {
    await browser.close();
  }
});
