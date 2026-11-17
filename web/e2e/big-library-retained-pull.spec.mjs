// A returning phone with a cached big household normally starts its `/changes` pull without mutation policy. When an
// offline edit is retained, that pull must remain just as eager: deferred policy is needed to project/replay the edit,
// not to begin reading remote changes. This runs against the production build, beside the other big-library budgets.
//
// Both opens use Chromium's 4x CPU slowdown and an 80 ms / 1.6 Mbps phone link. On the retained-work open the real
// deferred-policy wasm response is delayed as a deterministic stand-in for a slow fetch+compile. The timing is from
// navigation start to the first production `/changes` request; the request must start before that delayed response.

import { test, expect, chromium, devices } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge } from './guest-edge.mjs';
import { bigHousehold, routeBigHousehold } from './big-library.mjs';

const CPU_SLOWDOWN = 4;
const ROUND_TRIP_MS = 80;
const DOWNLOAD_BYTES_PER_SECOND = 200_000; // 1.6 Mbps.
const UPLOAD_BYTES_PER_SECOND = 93_750; // 750 Kbps.
const DEFERRED_DELAY_MS = 2_500;
/** The retained path may add bookkeeping, but never the deliberately held policy response. */
const RETAINED_OVER_BASELINE_MS = 750;

async function phoneNetwork(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: ROUND_TRIP_MS,
    downloadThroughput: DOWNLOAD_BYTES_PER_SECOND,
    uploadThroughput: UPLOAD_BYTES_PER_SECOND,
    connectionType: 'cellular4g',
  });
}

/** Open the cached production app and time its first library pull. */
async function measureFirstPull(context, edge, { holdDeferred = false } = {}) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  await phoneNetwork(context, page);

  let deferredAskedAt = null;
  let deferredReleasedAt = null;
  if (holdDeferred)
    await page.route(/\/den_core_deferred_bg(?:-[\w-]+)?\.wasm$/, async (route) => {
      deferredAskedAt ??= performance.now();
      await new Promise((resolve) => setTimeout(resolve, DEFERRED_DELAY_MS));
      deferredReleasedAt = performance.now();
      await route.continue();
    });

  let firstPull;
  const pulled = new Promise((resolve) => {
    page.on('request', (request) => {
      if (!firstPull && /\/lib\/[^/]+\/changes\?/.test(request.url())) {
        firstPull = performance.now();
        resolve();
      }
    });
  });
  const openedAt = performance.now();
  await page.goto(`${E2E_ORIGIN}/`, { waitUntil: 'commit' });
  await Promise.race([
    pulled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cached open made no changes request')), 30_000),
    ),
  ]);
  const changesMs = Math.round(firstPull - openedAt);

  if (holdDeferred) {
    await expect
      .poll(() => deferredAskedAt, {
        timeout: 30_000,
        message: 'retained semantic work asks for deferred policy',
      })
      .not.toBeNull();
    await expect
      .poll(() => deferredReleasedAt, {
        timeout: 30_000,
        message: 'the delayed deferred-policy response finishes',
      })
      .not.toBeNull();
  }
  const measured = {
    changesMs,
    deferredAskedMs: deferredAskedAt && Math.round(deferredAskedAt - openedAt),
    deferredReleasedMs: deferredReleasedAt && Math.round(deferredReleasedAt - openedAt),
  };
  await page.close();
  return measured;
}

/** Make one real semantic edit while its batch route is offline; production keeps it for the next open. */
async function retainOfflineEdit(context, edge) {
  const page = await context.newPage();
  await routeBigHousehold(page, edge);
  await page.goto(`${E2E_ORIGIN}/`);
  const row = page.getByRole('region', { name: 'New Releases', exact: true });
  const title = row.getByRole('link', { name: 'Film 300000' }).first();
  await expect(title).toBeVisible({ timeout: 30_000 });

  const batchesBefore = edge.libraryRequests.filter(({ action }) => action === 'batch').length;
  await page.route(/\/lib\/[^/]+\/batch$/, (route) => route.abort('internetdisconnected'));
  try {
    await title.hover();
    await row.getByRole('button', { name: 'Actions for Film 300000' }).first().click();
    await page
      .getByRole('menu', { name: 'Actions for Film 300000' })
      .getByRole('menuitemcheckbox', { name: 'Add to watchlist' })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'Added “Film 300000”' })).toBeVisible({
      timeout: 30_000,
    });
    expect(
      edge.libraryRequests.filter(({ action }) => action === 'batch').length,
      'offline edit never reached den-edge',
    ).toBe(batchesBefore);
  } finally {
    await page.close();
  }
}

test('retained work does not hold a cached phone’s first pull behind deferred policy', async () => {
  test.setTimeout(600_000);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const { defaultBrowserType: _, ...phone } = devices['Pixel 7'];
    const context = await browser.newContext(phone);
    const edge = newEdge({ profiles: true });
    await bigHousehold(context, edge);

    const baseline = await measureFirstPull(context, edge);
    await retainOfflineEdit(context, edge);
    const retained = await measureFirstPull(context, edge, {
      holdDeferred: true,
    });
    console.log(
      `retained-pull measurement ${JSON.stringify({
        profile: 'Pixel 7',
        cpuSlowdown: CPU_SLOWDOWN,
        network: {
          roundTripMs: ROUND_TRIP_MS,
          downloadMbps: 1.6,
          uploadMbps: 0.75,
        },
        deferredDelayMs: DEFERRED_DELAY_MS,
        baseline,
        retained,
        retainedMinusBaselineMs: retained.changesMs - baseline.changesMs,
      })}`,
    );

    expect
      .soft(retained.changesMs, 'retained first pull starts before deferred policy answers')
      .toBeLessThan(retained.deferredReleasedMs);
    expect
      .soft(retained.changesMs - baseline.changesMs, 'retained-work overhead over a cached open')
      .toBeLessThan(RETAINED_OVER_BASELINE_MS);
  } finally {
    await browser.close();
  }
});
