import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';

test('opt-in device checks exercise storage and a real Worker without retaining probe data', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  const workers = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto(`${E2E_ORIGIN}/?tv-diagnostics=1&private=do-not-report`);
  await page.getByText('TV diagnostics', { exact: true }).click();
  const panel = page.locator('#den-tv-diagnostics');
  const run = panel.getByRole('button', { name: 'Run device checks' });
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText(
    'Web Crypto: passed\nIndexedDB write/read: passed\nWorker + Crypto + WASM: passed',
  );
  await expect(run).toBeEnabled();
  expect(workers.some((url) => /diagnosticWorker-/.test(url))).toBe(true);
  await expect(panel).not.toContainText('do-not-report');
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await indexedDB.databases()).filter((database) =>
            database.name.startsWith('den-tv-check-'),
          ).length,
      ),
    )
    .toBe(0);
});

test('device checks stay available after startup failure and redact API errors', async ({
  page,
}) => {
  await routeGuestEdge(page, newEdge());
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { value: false });
    IDBFactory.prototype.open = () => {
      throw new Error('secret-token-in-storage-error');
    };
  });
  await page.goto(`${E2E_ORIGIN}/?tv-diagnostics=1`);
  await expect(page.getByRole('alert')).toContainText('trusted HTTPS');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#den-tv-diagnostics summary')).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = page.locator('#den-tv-diagnostics');
  await page.keyboard.press('ArrowDown');
  await expect(panel.getByRole('button', { name: 'Run device checks' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toContainText('IndexedDB write/read: failed');
  await expect(panel).not.toContainText('secret-token');
});
