// The household's debrid service (TorBox, behind Den Hearth) as Hearth's `/health` reports it, through the real app:
// a library kept in this browser lists Hearth's combined addon, and opening the app reads that Hearth's health once.
// A down or slow service is said in the page toast; a healthy one, or a Hearth that says nothing of it, is not.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { routeTmdb } from './network.mjs';

const INSTALL = `${E2E_ORIGIN}/den/hearthcfg/manifest.json`;
const DOWN = 'TorBox isn’t responding right now — playback may fail.';
const SLOW = 'TorBox is slow right now — streams may take longer to start.';

/** The app open on Home, with Hearth's `/health` answering `health`. Returns how many times it was asked. */
async function openWith(page, health) {
  const asked = { health: 0 };
  await routeTmdb(page, (route) =>
    route.fulfill({ json: { page: 1, results: [], total_pages: 1 } }),
  );
  await page.route(`${E2E_ORIGIN}/config`, (route) => route.fulfill({ json: {} }));
  await page.route(`${E2E_ORIGIN}/routes`, (route) =>
    route.fulfill({ json: { v: 1, addons: { den: [{ url: `${E2E_ORIGIN}/den` }] } } }),
  );
  await page.route(`${E2E_ORIGIN}/den/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/den/hearthcfg/manifest.json')
      return route.fulfill({
        json: { id: 'com.den.hearth', version: '1.0.0', resources: ['stream'] },
      });
    if (path === '/den/health') {
      asked.health++;
      return route.fulfill({ json: health });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });
  await page.goto(`${E2E_ORIGIN}/test/seed-library.html`);
  await page.waitForFunction(() => typeof window.denSeed === 'function');
  await page.evaluate(
    (rows) => window.denSeed(rows),
    [
      {
        kind: 'set',
        schema: 2,
        name: 'plugins',
        values: {
          [INSTALL]: { value: { bool: true }, at: [Date.now() - 60_000, 0, 'aaaaaaaaaaaaaaaa'] },
        },
      },
    ],
  );
  await page.goto(`${E2E_ORIGIN}/`);
  return asked;
}

const hearth = (debrid) => ({
  status: 'ok',
  services: { scout: { status: 'ok' } },
  ...(debrid ? { debrid } : {}),
});

test('a down debrid service is said once in the page toast when the app opens', async ({
  page,
}) => {
  const asked = await openWith(
    page,
    hearth({
      provider: 'torbox',
      state: 'down',
      since: Date.now() - 60_000,
      reason: 'unreachable',
    }),
  );
  await expect(page.getByRole('status').filter({ hasText: DOWN })).toBeVisible({ timeout: 30_000 });
  expect(asked.health).toBe(1);
  // Moving about the app is not a new state: nothing is asked or said again.
  await page.getByRole('link', { name: 'Watchlist' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: DOWN })).toBeHidden({ timeout: 10_000 });
  expect(asked.health).toBe(1);
});

test('a slow debrid service is said in the page toast', async ({ page }) => {
  await openWith(
    page,
    hearth({ provider: 'torbox', state: 'slow', since: Date.now(), reason: 'latency' }),
  );
  await expect(page.getByRole('status').filter({ hasText: SLOW })).toBeVisible({ timeout: 30_000 });
});

for (const [name, debrid] of [
  ['healthy', { provider: 'torbox', state: 'ok', since: Date.now(), reason: 'ok' }],
  ['not reported', null],
]) {
  test(`a debrid service that is ${name} is not mentioned`, async ({ page }) => {
    const asked = await openWith(page, hearth(debrid));
    await expect.poll(() => asked.health, { timeout: 30_000 }).toBe(1);
    // Give the answer time to reach the page before saying nothing came of it.
    await page.waitForTimeout(1_000);
    await expect(page.getByText(/TorBox/)).toHaveCount(0);
  });
}
