import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

const locator = (character) => character.repeat(32);

async function make(page, lastGroup) {
  await page.getByRole('button', { name: 'Make a recovery code' }).click();
  await expect(page.locator('.code')).toBeVisible();
  await page.getByRole('textbox', { name: 'The code’s last four characters' }).fill(lastGroup);
}

test('confirmation owns teardown and cannot publish into a newer ceremony', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await make(page, '1111');
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  await page.evaluate(() => {
    globalThis.recoveryFixture.unmount();
    globalThis.recoveryFixture.remount();
    globalThis.recoveryFixture.confirmations([{ state: 'committed' }]);
  });
  await make(page, '2222');
  await page.evaluate(
    ({ locator }) => globalThis.recoveryFixture.release(locator, { state: 'committed' }),
    { locator: locator('a') },
  );
  await expect(page.locator('.code')).toHaveText('BBBB-BBBB-BBBB-BBBB-BBBB-2222');
  await expect(page.getByText('Your recovery code is on.')).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.recoveryFixture.events())).toEqual([
    { kind: 'confirm', locator: locator('a') },
  ]);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Make a recovery code' })).toBeVisible();
  expect(await page.evaluate(() => globalThis.recoveryFixture.events())).toEqual([
    { kind: 'confirm', locator: locator('a') },
    { kind: 'abandon', locator: locator('b') },
  ]);
  expect(await page.evaluate(() => globalThis.recoveryFixture.held())).toEqual([]);
});

test('a confirmation that remains pending after teardown gets authoritative cleanup', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await make(page, '1111');
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();

  await page.evaluate(() => {
    globalThis.recoveryFixture.unmount();
    globalThis.recoveryFixture.release('a'.repeat(32), { state: 'pending' });
  });
  await expect
    .poll(() => page.evaluate(() => globalThis.recoveryFixture.events()))
    .toEqual([
      { kind: 'confirm', locator: locator('a') },
      { kind: 'abandon', locator: locator('a') },
    ]);
  expect(await page.evaluate(() => globalThis.recoveryFixture.held())).toEqual([]);
});

test('failed and lost confirmation retain explicit recovery actions', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/recovery-code.html`);
  await page.evaluate(() =>
    globalThis.recoveryFixture.confirmations([
      { state: 'pending' },
      { state: 'committed' },
      { state: 'lost' },
    ]),
  );
  await make(page, '1111');
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(
    page.getByText(
      'Couldn’t save that. Check that this device is on your network, then confirm again.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'I’ve saved it' }).click();
  await expect(page.getByText('Your recovery code is on.')).toBeVisible();

  await make(page, '2222');
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
