// A return visit draws what this browser holds at once, with its unsent work drawn over it. Work still kept at a
// reload (an offline edit, or the device check-in left unanswered) used to make the library Worker load deferred
// policy and send that work before it answered any view: Settings showed only "Loading your settings…" and Home no
// rows until both had finished, and with deferred policy slow to arrive the page stayed empty that long.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN as ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const BATCH = /\/lib\/[^/]+\/batch$/;
const DEFERRED = /\/den_core_deferred_bg(?:-[\w-]+)?\.wasm$/;

test('a reload with unsent work draws Settings and Home before deferred policy loads', async ({
  page,
}) => {
  const edge = newEdge();
  await routeGuestEdge(page, edge);
  // A title on the watchlist, then the invite accepted: the guest library starts with it.
  await page.goto(`${ORIGIN}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await page.goto(`${ORIGIN}/movie/1002`);
  const add = page.getByRole('button', { name: 'Watchlist', exact: true });
  await add.click();
  await expect(add).toHaveAttribute('aria-pressed', 'true');
  await expect(add).not.toHaveAttribute('data-saving', 'true');
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
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);

  await page.goto(`${ORIGIN}/settings`);
  const waiting = page
    .locator('#diagnostics-panel dl > div', { hasText: 'Waiting to sync' })
    .locator('dd');
  await page.locator('#linked-devices > button.row').click();
  await expect(page.locator('#linked-devices .device-self')).toBeVisible({ timeout: 30_000 });
  await page.locator('#diagnostics > button.row').click();
  await expect(waiting).toHaveText('Nothing', { timeout: 30_000 });

  // den-edge is out of reach for writes from here: the next edit is kept in this browser, unsent.
  await page.route(BATCH, (route) => route.abort('internetdisconnected'));
  const subtitles = page.locator('#subtitle-language select');
  await expect(subtitles).toBeEnabled({ timeout: 30_000 });
  await subtitles.selectOption('sv');
  await expect(waiting).not.toHaveText('Nothing', { timeout: 30_000 });

  // Deferred policy is held from here until released below, in the page and its library Worker.
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let deferredReleased = false;
  await page.route(DEFERRED, async (route) => {
    await released;
    deferredReleased = true;
    await route.continue();
  });

  try {
    await page.reload();
    // Settings draws the library's own playback settings, the unsent subtitle choice among them.
    await expect(page.locator('#playback select, #playback input')).toHaveCount(6, {
      timeout: 30_000,
    });
    await expect(page.locator('#subtitle-language select')).toHaveValue('sv');

    // Home draws the watchlist this browser holds.
    await page.goto(`${ORIGIN}/`);
    await expect(
      page
        .getByRole('region', { name: 'Watchlist', exact: true })
        .getByRole('link', { name: /Movie 1002/ })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(deferredReleased, 'both drew while deferred policy was still held').toBe(false);
  } finally {
    release();
  }

  // Once den-edge takes writes again, the kept edit is sent and nothing waits.
  await page.unroute(BATCH);
  await page.goto(`${ORIGIN}/settings`);
  await page.locator('#diagnostics > button.row').click();
  await expect(
    page.locator('#diagnostics-panel dl > div', { hasText: 'Waiting to sync' }).locator('dd'),
  ).toHaveText('Nothing', { timeout: 60_000 });
  await expect(page.locator('#subtitle-language select')).toHaveValue('sv');
});
