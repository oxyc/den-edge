import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('Tizen 3 gives Kid content a browser handoff and names Visitor content as device-local', async ({
  page,
}) => {
  test.skip(
    process.env.DEN_TIZEN_VERSION !== '3.0',
    'only the reduced Tizen 3 target replaces profile content administration',
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      'den.profile.active.v1',
      JSON.stringify({
        version: 1,
        mode: 'persistent',
        profileId: '00000000000000000000000000000001',
      }),
    ),
  );
  await page.route('**/capabilities/profiles', (route) =>
    route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { enabled: true, preview: true },
    }),
  );
  await page.goto(`${E2E_ORIGIN}/test/profile-mode.html?settings`);
  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Kids' }).click();

  const kidHandoff = page.getByRole('button', {
    name: 'Manage profile content in a supported browser Profile content administration is not available on this TV',
  });
  await expect(kidHandoff).toBeVisible();
  await kidHandoff.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText(
      'On a phone or computer linked to this household, switch to this profile and open Den › Settings › Content.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(`${E2E_ORIGIN}/settings#content`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hidden genres' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Switch profile, current Kids' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await page.getByLabel('Owner PIN').fill('1234');
  await expect(page.getByRole('button', { name: 'Switch profile, current Visitor' })).toBeVisible();
  const visitorNotice = page.getByRole('button', {
    name: 'Visitor content preferences are unavailable on this TV Visitor preferences stay on the device where that visit was created',
  });
  await expect(visitorNotice).toBeVisible();
  await visitorNotice.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText(
      'Use this TV for playback, or end the Visitor visit and choose a household profile. Nothing is changed.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(`${E2E_ORIGIN}/settings#content`, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hidden genres' })).toHaveCount(0);
});
