import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { newEdge, routeGuestEdge } from './guest-edge.mjs';
import { trackRecoveryWorkers } from './recovery-workers.mjs';

test.skip(
  process.env.DEN_TIZEN_VERSION === '3.0',
  'Tizen 3 deliberately hands recovery to a phone or computer and has no recovery Worker',
);

test('modern TV recovery leaves and retries without overlapping its production Worker', async ({
  page,
}) => {
  await trackRecoveryWorkers(page);
  await routeGuestEdge(page, newEdge());
  let opens = 0;
  await page.route('**/recovery/timing', (route) => route.fulfill({ status: 204 }));
  await page.route('**/recovery/open', (route) => {
    opens++;
    return route.fulfill({ status: 404, json: { error: 'unknown_code' } });
  });
  await page.goto(E2E_ORIGIN);

  const code = 'GEB2-LP9U-C63W-Q95U-NSLT-XMFL';
  await page.getByText('Open with a recovery code', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  await page.getByRole('button', { name: 'Open with code' }).click();
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(1);
  await page.getByRole('button', { name: 'Look around instead' }).click();
  await expect.poll(() => page.evaluate(() => globalThis.recoveryWorkers.active)).toBe(0);
  expect(opens).toBe(0);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(`${E2E_ORIGIN}/settings`);
  await page.getByRole('button', { name: /Recovery code/ }).click();
  const recovery = page.getByRole('region', { name: 'Recovery code' });
  await recovery.getByRole('textbox', { name: 'Recovery code' }).fill(code);
  await recovery.getByRole('button', { name: 'Open with code' }).click();
  await expect(page.getByText(/This code doesn’t open a library/)).toBeVisible({ timeout: 30_000 });
  expect(opens).toBe(1);
  expect(await page.evaluate(() => globalThis.recoveryWorkers)).toMatchObject({
    active: 0,
    created: 2,
    maximum: 1,
    terminated: 2,
  });
});
