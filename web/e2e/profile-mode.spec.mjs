import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/profile-mode.html`;

async function open(page, enabled, suffix = '') {
  await guardNetwork(page);
  await page.route('**/capabilities/profiles', (route) =>
    enabled
      ? route.fulfill({ json: { enabled: true } })
      : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  await page.goto(`${FIXTURE}${suffix}`);
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture?.snapshot().checked))
    .toBe(true);
}

test('default-off capability leaves the legacy Owner path and storage untouched', async ({
  page,
}) => {
  await open(page, false);

  await expect(page.getByRole('button', { name: /Switch profile/ })).toHaveCount(0);
  await expect(page.locator('[data-mode]')).toHaveText('Legacy Owner active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.snapshot()))
    .toMatchObject({ enabled: false, mode: 'owner', keys: [] });
});

test('Visitor stays active across reload, PIN denial preserves it, and success disposes only its visit', async ({
  page,
}) => {
  const writes = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  await open(page, true, '?pin=1234');

  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect(page.getByText('Visitor can’t manage household settings.')).toBeVisible();
  const first = await page.evaluate(() => {
    window.denProfileModeFixture.setActivity('progress:movie:550', 'half');
    return window.denProfileModeFixture.snapshot();
  });
  expect(first.policyCeiling).toBe('pg13');

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture?.snapshot().checked))
    .toBe(true);
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.getActivity('progress:movie:550')))
    .toBe('half');
  expect((await page.evaluate(() => window.denProfileModeFixture.snapshot())).visitId).toBe(
    first.visitId,
  );

  writes.length = 0;
  await expect(page.evaluate(() => window.denProfileModeFixture.outbound())).resolves.toEqual([
    { outcome: 'suppressed' },
    { outcome: 'suppressed' },
  ]);
  expect(writes).toEqual([]);

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByLabel('Owner PIN').fill('0000');
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture.getActivity('progress:movie:550')))
    .toBe('half');

  await page.getByLabel('Owner PIN').fill('1234');
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
  const ended = await page.evaluate(() => window.denProfileModeFixture.snapshot());
  expect(ended.keys).toEqual(['den.profile.active.v1']);
});
