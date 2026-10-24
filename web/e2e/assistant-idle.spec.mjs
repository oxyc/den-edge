import { test, expect, chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { E2E_ORIGIN } from './base-url.mjs';

/**
 * A member's library with no assistant connection, open in the real app over an empty den-edge: the page must do no
 * assistant work at all — no drain, no renewal, no projection — and never fetch the assistant code: neither the
 * page's loops nor the Worker's assistant module and its wasm.
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
    let startupCore = false;
    let deferredCore = false;
    const timing = {};
    const headers = { 'x-den-generation': 'idle', 'x-den-wire-min': '4' };
    // The page's assistant loops, and den-core's assistant module with its wasm. (The Worker's few lines that would
    // load it, `assistantCore.ts`, are part of the Worker itself.)
    const assistantCode =
      /^\/src\/(?:lib\/assistant\.ts|vendor\/den-core\/assistant\.js|vendor\/den-core\/generated\/den_core_assistant)/;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== E2E_ORIGIN) return route.abort('blockedbyclient');
      if (/^\/(?:src\/|@|node_modules\/)/.test(url.pathname) || url.pathname === '/') {
        if (assistantCode.test(url.pathname)) assistant.push(url.pathname);
        // The Worker's own fetches pass here too. Opening uses startup policy; an idle library has no reason to
        // fetch mutation/delivery policy.
        if (url.pathname.endsWith('/generated/den_core_startup_bg.wasm')) {
          startupCore = true;
          timing.startup ??= Date.now();
        }
        if (url.pathname.endsWith('/generated/den_core_deferred_bg.wasm')) {
          deferredCore = true;
          timing.deferred ??= Date.now();
        }
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
    page.on('console', (message) => {
      if (message.text().includes('library import finished')) timing.importFinished ??= Date.now();
    });
    await page.goto(`${E2E_ORIGIN}/`);
    await expect.poll(() => synced, { timeout: 20_000 }).toBeGreaterThan(1);
    // The finished views' reads come first and need no policy; the Worker asks for startup policy once it is ready,
    // a few milliseconds after them, so it is waited for rather than sampled.
    await expect
      .poll(() => startupCore, { timeout: 15_000, message: 'the Worker’s startup fetch is seen' })
      .toBe(true);
    await expect
      .poll(() => deferredCore, {
        timeout: 15_000,
        message: 'the automatic device check-in eventually loads deferred policy',
      })
      .toBe(true);
    expect(timing.startup, 'browse policy is requested before mutation policy').toBeLessThan(
      timing.deferred,
    );
    expect(
      timing.importFinished,
      'the automatic heartbeat waits for the first library import',
    ).toBeLessThan(timing.deferred);
    expect(assistant).toEqual([]);
  } finally {
    await browser.close();
  }
});
