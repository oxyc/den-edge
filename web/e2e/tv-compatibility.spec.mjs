import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

// Remove later APIs, not application functions. Both realms must still open the real encrypted library,
// save a title through den-core, and read it after reload. This is NOT an old-engine or codec emulator.
const olderAPIs = `
delete Array.prototype.at;
delete String.prototype.at;
delete Object.hasOwn;
delete globalThis.structuredClone;
delete Crypto.prototype.randomUUID;
delete AbortSignal.timeout;
delete AbortSignal.any;
delete AbortSignal.prototype.throwIfAborted;
delete AbortSignal.prototype.reason;
`;

test('built TV page and Worker keep a real library when later runtime APIs are absent', async ({
  page,
}) => {
  const errors = [];
  const workers = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => workers.push(worker.url()));
  await routeGuestEdge(page, newEdge());
  await page.addInitScript(olderAPIs);
  await page.route('**/assets/*Worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: olderAPIs + (await response.text()) });
  });
  const initialCapability = page.waitForResponse('**/capabilities/profiles');
  await page.goto(`${E2E_ORIGIN}/movie/1002`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  const save = page.getByRole('button', { name: 'Watchlist', exact: true });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await initialCapability;
  const saveCapability = page.waitForResponse('**/capabilities/profiles');
  await save.click();
  await expect(save).toHaveAttribute('aria-pressed', 'true');
  // Saving probes whether a local library can become a household. Finish that
  // real request before destroying its document; WebKit reports unload-time
  // fetches as access-control page errors even when the response is same-origin.
  await saveCapability;
  await page.reload();
  await expect(save).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await page.getByRole('link', { name: 'Watchlist', exact: true }).click();
  await expect(page.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  expect(workers.some((url) => /\/assets\/libraryServiceWorker-/.test(url))).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.locator('script[src^="/src/"]').count()).toBe(0);
});

test('TV startup explains missing secure context and leaves a remote-focusable retry', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.addInitScript(() =>
    Object.defineProperty(window, 'isSecureContext', { value: false }),
  );
  await page.goto(E2E_ORIGIN);
  await expect(page.getByRole('alert')).toContainText('trusted HTTPS');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused();
});
