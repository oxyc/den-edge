import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';
import { trackRecoveryWorkers } from './recovery-workers.mjs';

async function make(page) {
  await page.getByRole('button', { name: 'Make a recovery code' }).click();
  const code = page.locator('.code');
  await expect(code).toBeVisible({ timeout: 30_000 });
  const shown = (await code.textContent()).trim();
  await page
    .getByRole('textbox', { name: 'The code’s last four characters' })
    .fill(shown.slice(-4));
  return shown;
}

test('leaving and retrying does not overlap or retain recovery derivation Workers', async ({
  page,
}, testInfo) => {
  await trackRecoveryWorkers(page);
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);

  // Each derivation's answer is held, so the page is left, and retried, while one is certainly running.
  await page.evaluate(() => globalThis.recoveryWorkers.hold());
  await page.getByRole('button', { name: 'Make a recovery code' }).click();
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(1);
  await page.evaluate(() => globalThis.recoveryFixture.unmount());
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(0);

  await page.evaluate(() => globalThis.recoveryFixture.remount());
  const retryStarted = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: 'Make a recovery code' }).click();
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(1);
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.maximum)).toBe(1);
  const retryAllocatedInMs = await page.evaluate(
    (started) => globalThis.recoveryWorkers.createdAt.at(-1) - started,
    retryStarted,
  );
  await page.evaluate(() => globalThis.recoveryWorkers.release());
  await expect(page.locator('.code')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(0);
  expect(await page.evaluate(() => globalThis.recoveryWorkers)).toMatchObject({
    active: 0,
    created: 2,
    maximum: 1,
    terminated: 2,
  });
  await testInfo.attach('recovery-worker-metrics', {
    body: JSON.stringify({ retryAllocatedInMs }),
    contentType: 'application/json',
  });
});

test('leaving and retrying redemption cancels its Worker before any stale network work', async ({
  page,
}) => {
  await trackRecoveryWorkers(page);
  let opens = 0;
  await page.route('**/recovery/timing', (route) => route.fulfill({ status: 204 }));
  await page.route('**/recovery/open', (route) => {
    opens++;
    return route.fulfill({ status: 404, json: { error: 'unknown_code' } });
  });
  await page.goto(`${E2E_ORIGIN}/test/recovery-redeem.html`);
  const code = 'GEB2-LP9U-C63W-Q95U-NSLT-XMFL';
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  // Held, so the page is left while its derivation is certainly running.
  await page.evaluate(() => globalThis.recoveryWorkers.hold());
  await page.getByRole('button', { name: 'Open with code' }).click();
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(1);
  await page.evaluate(() => globalThis.recoveryRedeemFixture.unmount());
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(0);
  await page.evaluate(() => globalThis.recoveryWorkers.release());
  expect(opens).toBe(0);

  await page.evaluate(() => globalThis.recoveryRedeemFixture.remount());
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  await page.getByRole('button', { name: 'Open with code' }).click();
  await expect(page.getByText(/This code doesn’t open a library/)).toBeVisible({ timeout: 30_000 });
  expect(opens).toBe(1);
  expect(await page.evaluate(() => globalThis.recoveryRedeemFixture.opened())).toEqual([]);
  expect(await page.evaluate(() => globalThis.recoveryWorkers)).toMatchObject({
    active: 0,
    created: 2,
    maximum: 1,
    terminated: 2,
  });
});

test('confirmation owns teardown and cannot publish into a newer ceremony', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await make(page);
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  const oldLocator = await page.evaluate(() => globalThis.recoveryFixture.held()[0]);
  await page.evaluate(() => {
    globalThis.recoveryFixture.unmount();
    globalThis.recoveryFixture.remount();
    globalThis.recoveryFixture.confirmations(['committed']);
  });
  const currentCode = await make(page);
  await page.evaluate(({ locator }) => globalThis.recoveryFixture.release(locator, 'committed'), {
    locator: oldLocator,
  });
  await expect(page.locator('.code')).toHaveText(currentCode);
  await expect(page.getByText('Your recovery code is on.')).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.recoveryFixture.events())).toEqual([
    { kind: 'confirm', locator: oldLocator },
  ]);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Make a recovery code' })).toBeVisible();
  const events = await page.evaluate(() => globalThis.recoveryFixture.events());
  expect(events).toHaveLength(2);
  expect(events[0]).toEqual({ kind: 'confirm', locator: oldLocator });
  expect(events[1].kind).toBe('abandon');
  expect(events[1].locator).not.toBe(oldLocator);
  expect(await page.evaluate(() => globalThis.recoveryFixture.held())).toEqual([]);
});

test('a confirmation that remains pending after teardown gets authoritative cleanup', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await make(page);
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  const oldLocator = await page.evaluate(() => globalThis.recoveryFixture.held()[0]);
  await page.evaluate(
    ({ locator }) => {
      globalThis.recoveryFixture.unmount();
      globalThis.recoveryFixture.release(locator, 'pending');
    },
    { locator: oldLocator },
  );
  await expect
    .poll(() => page.evaluate(() => globalThis.recoveryFixture.events()))
    .toEqual([
      { kind: 'confirm', locator: oldLocator },
      { kind: 'abandon', locator: oldLocator },
    ]);
  expect(await page.evaluate(() => globalThis.recoveryFixture.held())).toEqual([]);
});

test('failed cancellation stays visible and retries the same durable cleanup', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await page.evaluate(() => globalThis.recoveryFixture.abandonments(['failed', 'abandoned']));
  await make(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(
    page.getByText(
      'Couldn’t cancel that recovery code setup. Check your connection and try again.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  const locator = await page.evaluate(() => globalThis.recoveryFixture.events()[0].locator);
  expect(await page.evaluate(() => globalThis.recoveryFixture.pending())).toEqual([locator]);

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Make a recovery code' })).toBeVisible();
  expect(await page.evaluate(() => globalThis.recoveryFixture.events())).toEqual([
    { kind: 'abandon', locator },
    { kind: 'abandon', locator },
  ]);
  expect(await page.evaluate(() => globalThis.recoveryFixture.pending())).toEqual([]);
});

test('failed and lost confirmation retain explicit recovery actions', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await page.evaluate(() =>
    globalThis.recoveryFixture.confirmations(['pending', 'committed', 'lost']),
  );
  await make(page);
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(
    page.getByText(
      'Couldn’t save that. Check that this device is on your network, then confirm again.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.getByText('Your recovery code is on.')).toBeVisible();

  await make(page);
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(
    page.getByText('That pending recovery code was replaced. Make a new one.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Make a recovery code' })).toBeVisible();
});

test('Settings replaces a recovery authority without crossing or losing a committed ceremony', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('**/tmdb/3/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/recovery/timing', (route) => route.fulfill({ status: 204 }));
  await page.goto(`${E2E_ORIGIN}/test/settings.html?recovery-authority-replacement`);
  await page.getByRole('button', { name: /Recovery code/ }).click();
  const recovery = page.getByRole('region', { name: 'Recovery code' });
  await recovery.getByRole('button', { name: 'Make a recovery code' }).click();
  const code = recovery.locator('.code');
  await expect(code).toBeVisible({ timeout: 30_000 });
  const shown = (await code.textContent()).trim();
  await recovery
    .getByRole('textbox', { name: 'The code’s last four characters' })
    .fill(shown.slice(-4));
  await recovery.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureRecoveryAuthority.held()))
    .toBe(true);

  await page.evaluate(() => globalThis.fixtureRecoveryAuthority.replace());
  // The retained Settings page stays mounted, but its keyed recovery presentation forgets the old authority's code.
  await expect(code).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Make a recovery code' })).toBeVisible();

  await page.evaluate(() => globalThis.fixtureRecoveryAuthority.release());
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureRecoveryAuthority.tasks()))
    .toEqual({
      primary: ['recovery.begin', 'recovery.confirm', 'recovery.abandon'],
      replacement: [],
    });
  // The old authority lost its successful reply. Its serialized cleanup rereads the live row and preserves it; the
  // replacement lease then publishes that durable truth.
  await page.evaluate(() => globalThis.fixtureRecoveryAuthority.reread());
  await expect(recovery.getByText(/^On · made /)).toBeVisible();
});
