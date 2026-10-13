import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('Owner enables profiles with one exact attempt after establishing a missing PIN', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/profiles-settings.html`);
  await expect(page.getByRole('heading', { name: 'Profiles', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Enable Profiles' }).click();

  await expect(page.getByRole('heading', { name: 'Create your Owner PIN' })).toBeVisible();
  await page.locator('#profiles-owner-pin').fill('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Kid profile').locator('..')).toContainText('Coming next');
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual([
      'set:1234',
      'observe',
      'verify:1234',
      `enable:0123456789abcdef0123456789abcdef:7:${'a'.repeat(64)}`,
    ]);
});

test('recovery observes and binds its own source before the fresh Owner PIN', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/profiles-settings.html?recovery`);
  await page.getByRole('button', { name: 'Recover safely' }).click();
  await expect(page.getByRole('heading', { name: 'Authorize profile recovery' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual(['observe-recovery:0123456789abcdef0123456789abcdef']);

  await page.locator('#profiles-owner-pin').fill('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual([
      'observe-recovery:0123456789abcdef0123456789abcdef',
      'verify:1234',
      `recover:0123456789abcdef0123456789abcdef:${'f'.repeat(32)}:7:${'a'.repeat(64)}`,
    ]);
});

test('a queued new Owner PIN never observes or enables profiles', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/profiles-settings.html?queued`);
  await page.getByRole('button', { name: 'Enable Profiles' }).click();
  await page.locator('#profiles-owner-pin').fill('1234');

  await expect(page.getByText('Your Owner PIN is waiting to sync.')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual(['set:1234']);
});

test('a reloaded queued PIN requires an exact synced retry before source observation', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/profiles-settings.html?reloaded-pending`);
  await page.getByRole('button', { name: 'Enable Profiles' }).click();
  await expect(page.getByRole('heading', { name: 'Finish saving your Owner PIN' })).toBeVisible();
  expect(await page.evaluate(() => window.profileSettingsEvents())).toEqual([]);

  await page.locator('#profiles-owner-pin').fill('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual([
      'set:1234',
      'observe',
      'verify:1234',
      `enable:0123456789abcdef0123456789abcdef:7:${'a'.repeat(64)}`,
    ]);
});
