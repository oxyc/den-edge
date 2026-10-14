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
  await expect(page.locator('#profile-create-kid')).toContainText('Not created');
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual([
      'set:1234',
      'observe',
      'verify:1234',
      `enable:0123456789abcdef0123456789abcdef:7:${'a'.repeat(64)}`,
    ]);
});

test('Owner creates a fail-closed Kid profile with a name, age and one PIN entry', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/profiles-settings.html?enabled`);
  await page.getByRole('button', { name: 'Create Kid profile' }).click();

  await expect(page.getByRole('heading', { name: 'Create a Kid profile' })).toBeVisible();
  await page.getByLabel('Name').fill('Mina');
  await page.getByLabel('Maximum age rating').fill('8');
  await page.locator('#profiles-owner-pin').fill('1234');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#profile-create-kid')).toContainText('Mina is ready.');
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual(['verify:1234', 'create:Mina:8:1234']);
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

test('a locked household offers the journal-less Owner Restore, bound to its own fresh source', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/profiles-settings.html?locked`);
  await expect(page.locator('#profile-migration')).toContainText('Setup in progress');
  await expect(page.getByRole('button', { name: 'Enable Profiles' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Recover safely' }).click();
  await expect(page.getByRole('heading', { name: 'Authorize profile recovery' })).toBeVisible();

  await page.locator('#profiles-owner-pin').fill('1234');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // No split journal, so no attempt is named: only the fresh recovery attempt and its observed source.
  await expect
    .poll(() => page.evaluate(() => window.profileSettingsEvents()))
    .toEqual([
      'observe-recovery:null',
      'verify:1234',
      `recover:null:${'f'.repeat(32)}:7:${'a'.repeat(64)}`,
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
