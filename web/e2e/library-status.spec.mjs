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
