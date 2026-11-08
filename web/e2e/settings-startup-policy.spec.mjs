// A saved page language and subtitle choice are read on the first frame, from startup policy. Deferred policy
// (mutations, delivery) loads later and may take a while on a slow phone; until it does, a library that had changed
// either setting used to read as English with subtitles explicitly Off, and a title played then started without the
// subtitle it should have had.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { routeTmdb } from './network.mjs';

test('a saved language and Automatic subtitles read correctly before deferred policy loads', async ({
  page,
}) => {
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  await routeTmdb(page, (route) =>
    route.fulfill({ json: { page: 1, total_pages: 1, results: [] } }),
  );
  await page.goto(`${ORIGIN}/#invite=${CODE}`);
  await page
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? 'null')?.[0]?.guest),
      { timeout: 30_000 },
    )
    .toBe(true);

  const batch = (response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/batch');
  const changes = (response) => new URL(response.url()).pathname.endsWith('/changes');
  await Promise.all([
    page.waitForResponse(changes, { timeout: 30_000 }),
    page.goto(`${ORIGIN}/settings`),
  ]);
  const subtitles = page.locator('#subtitle-language select');
  const language = page.locator('#interface-language select');
  // Swedish, then back to Automatic: the stored row now holds the cleared subtitle keys, which only den-core reads.
  for (const [select, value] of [
    [subtitles, 'sv'],
    [subtitles, '__automatic'],
    [language, 'sv'],
  ]) {
    await expect(select).toBeEnabled({ timeout: 30_000 });
    const [saved] = await Promise.all([
      page.waitForResponse(batch, { timeout: 30_000 }),
      select.selectOption(value),
    ]);
    expect(saved.ok()).toBe(true);
  }

  // Deferred policy never arrives from here on, in the page or its library Worker: its request is left unanswered.
  await page.route('**/den_core_deferred_bg.wasm', () => {});
  // What the page draws now comes from this browser's own copy; a pull may wait on deferred policy, so none is awaited.
  await page.reload();
  await expect(page.locator('#subtitle-language select')).toHaveValue('__automatic', {
    timeout: 30_000,
  });
  await expect(page.locator('#interface-language select')).toHaveValue('sv');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
});
