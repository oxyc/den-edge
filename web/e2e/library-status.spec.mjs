import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('an old browser-local backup can be explicitly discarded as empty', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/library-status.html`);

  await expect(page.getByRole('alert')).toContainText('This backup predates Library v4');
  await page.getByRole('button', { name: 'Start with an empty library…' }).click();
  await expect(page.getByRole('group', { name: 'Discard this old backup?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();

  await page.getByRole('button', { name: 'Start empty' }).click();
  await expect(page.getByRole('status')).toHaveText('Empty library started');
});

test('equal notices receive a fresh live region, lifetime and Undo owner', async ({ page }) => {
  await page.clock.install();
  await page.goto(`${E2E_ORIGIN}/test/library-status.html`);

  const notify = page.getByRole('button', { name: 'Notify briefly' });
  await notify.click();
  const status = page.locator('p.library-status.toast');
  const first = await status.elementHandle();
  await expect(status).toHaveText('Library is ready');

  await page.clock.fastForward(500);
  await notify.click();
  const replacement = await status.elementHandle();
  expect(await first.evaluate((node, next) => node === next, replacement)).toBe(false);

  // The first notice's original deadline cannot clear the equal replacement.
  await page.clock.fastForward(500);
  await expect(status).toHaveText('Library is ready');
  await page.clock.fastForward(500);
  await expect(status).toHaveCount(0);

  await page.getByRole('button', { name: 'First Undo notice' }).click();
  const firstUndo = await page
    .getByRole('button', { name: 'Undo', exact: true })
    .elementHandle();
  await page.getByRole('button', { name: 'Replacement Undo notice' }).click();
  expect(await firstUndo.evaluate((node) => node.isConnected)).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Undo owner' })).toHaveText('replacement');
});
