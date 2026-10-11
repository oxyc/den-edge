import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// Cloudflare can keep a shell several releases old when purging keeps failing, and that shell names hashed
// startup files den-edge no longer has: they answer 404 `no-store`. index.html's inline script loads the page once
// more under a `den-retry` query, which Cloudflare's cache cannot answer, and stops after that one try.

/** Serve the real shell for `/movies*`, its entry swapped for `entry(url)`; returns each document address asked. */
async function serveShell(page, entry) {
  const documents = [];
  await page.route('**/assets/**', (route) => {
    if (new URL(route.request().url()).pathname === '/assets/index-current.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'document.documentElement.dataset.booted = location.href;',
      });
    return route.fulfill({ status: 404, headers: { 'cache-control': 'no-store' }, body: '' });
  });
  await page.route(`${E2E_ORIGIN}/movies*`, async (route) => {
    const url = new URL(route.request().url());
    documents.push(url.pathname + url.search);
    const html = await (await route.fetch()).text();
    await route.fulfill({
      contentType: 'text/html',
      body: html.replace('/src/main.ts', entry(url)),
    });
  });
  return documents;
}

test('a shell naming missing startup files loads once more, past the shared cache', async ({
  page,
}) => {
  const documents = await serveShell(page, (url) =>
    url.searchParams.has('den-retry') ? '/assets/index-current.js' : '/assets/index-gone.js',
  );
  await page.goto(`${E2E_ORIGIN}/movies?keep=1#here`);

  // The retried shell started, at the address the person asked for: the retry marker is gone again.
  await expect(page.locator('html')).toHaveAttribute(
    'data-booted',
    `${E2E_ORIGIN}/movies?keep=1#here`,
  );
  expect(documents).toHaveLength(2);
  expect(documents[0]).toBe('/movies?keep=1');
  expect(documents[1]).toMatch(/^\/movies\?keep=1&den-retry=[0-9a-z]+$/);

  // A lazy chunk missing after load is `recoverChunkFailure`'s to handle, not this.
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = '/assets/lazy-gone.js';
    document.head.append(link);
  });
  await page.waitForTimeout(500);
  expect(documents).toHaveLength(2);
});

test('a retried shell that still cannot start says so instead of reloading again', async ({
  page,
}) => {
  const documents = await serveShell(page, () => '/assets/index-gone.js');
  await page.goto(`${E2E_ORIGIN}/movies`);

  await expect(page.getByRole('alert')).toHaveText(
    'Den could not load. Try again in a few minutes.',
  );
  await page.waitForTimeout(500);
  expect(documents).toHaveLength(2);
  expect(page.url()).toBe(`${E2E_ORIGIN}/movies`);
});
