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

test('capability discovery never exposes or enables the legacy Owner UI', async ({ page }) => {
  await guardNetwork(page);
  let answerCapability;
  const capability = new Promise((resolve) => (answerCapability = resolve));
  await page.route('**/capabilities/profiles', async (route) => {
    await capability;
    await route.fulfill({ json: { enabled: true } });
  });
  await page.goto(FIXTURE);

  await expect(page.getByRole('status')).toHaveText('Checking profiles…');
  await expect(page.locator('[data-mode]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Switch profile/ })).toHaveCount(0);
  answerCapability();
  await expect(page.getByRole('heading', { name: 'Owner access' })).toBeVisible();
  await expect(page.locator('[data-mode]')).toHaveCount(0);
});

test('missing active mode requires the configured Owner PIN and persists success', async ({
  page,
}) => {
  await open(page, true, '?pin=1234');

  await expect(page.locator('[data-mode]')).toHaveCount(0);
  await page.getByLabel('Owner PIN').fill('0000');
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.getByRole('alert')).toHaveText('That PIN didn’t match.');
  await expect(page.locator('[data-mode]')).toHaveCount(0);

  await page.getByLabel('Owner PIN').fill('1234');
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('den.profile.active.v1')))
    .toBe(JSON.stringify({ mode: 'owner' }));
});

test('a corrupt active marker cannot expose Owner without its PIN', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('den.profile.active.v1', '{broken'));
  await open(page, true, '?pin=1234');

  await expect(page.getByRole('heading', { name: 'Owner access' })).toBeVisible();
  await expect(page.locator('[data-mode]')).toHaveCount(0);
});

test('Visitor stays active across reload, PIN denial preserves it, and success disposes only its visit', async ({
  page,
}) => {
  const writes = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  await open(page, true, '?pin=1234');

  await page.getByLabel('Owner PIN').fill('1234');
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');

  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect(page.getByText('Visitor can’t manage household settings.')).toBeVisible();
  const first = await page.evaluate(async () => {
    await window.denProfileModeFixture.setActivity('progress:movie:550', 'half');
    return window.denProfileModeFixture.snapshot();
  });
  expect(first.policyCeiling).toBe('pg13');
  expect(first.policyKeys).toEqual(['settings']);
  expect(first.policyHasWriter).toBe(false);
  expect(first.householdExposesModel).toBe(false);
  expect(first.servicesExposeModel).toBe(false);

  writes.length = 0;
  await page.getByRole('button', { name: 'Add activity' }).click();
  await expect(page.getByRole('region', { name: 'Visitor watchlist' })).toContainText('Fight Club');
  await expect(page.getByRole('region', { name: 'Visitor Continue Watching' })).toContainText(
    'Game of Thrones 40%',
  );
  await expect(page.getByRole('region', { name: 'Visitor watched' })).toContainText('The Matrix');
  expect(writes).toEqual([]);

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.denProfileModeFixture?.snapshot().checked))
    .toBe(true);
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  await expect(page.getByRole('region', { name: 'Visitor watchlist' })).toContainText('Fight Club');
  await expect(page.getByRole('region', { name: 'Visitor Continue Watching' })).toContainText(
    'Game of Thrones 40%',
  );
  await expect(page.getByRole('region', { name: 'Visitor watched' })).toContainText('The Matrix');
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

test('a refused Visitor lock leaves the switch retryable and reports the failure', async ({
  page,
}) => {
  await open(page, true, '?pin=none&rejectLock');
  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  const marker = await page.evaluate(() => localStorage.getItem('den.profile.active.v1'));

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'The profile switch couldn’t be completed. Try again.',
  );
  await expect(page.locator('[data-mode]')).toHaveText('Visitor active');
  expect(await page.evaluate(() => localStorage.getItem('den.profile.active.v1'))).toBe(marker);

  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(page.locator('[data-mode]')).toHaveText('Owner active');
  expect(await page.evaluate(() => localStorage.getItem('den.profile.active.v1'))).toBe(
    JSON.stringify({ mode: 'owner' }),
  );
});

test('two tabs merge Visitor activity and an Owner switch revokes the stale tab', async ({
  page,
  context,
}) => {
  await open(page, true, '?pin=none');
  await page.getByRole('button', { name: 'Switch profile, current Owner' }).click();
  await page.getByRole('button', { name: 'Use Visitor' }).click();
  const visitId = (await page.evaluate(() => window.denProfileModeFixture.snapshot())).visitId;

  const other = await context.newPage();
  await open(other, true, '?pin=none');
  await expect(other.locator('[data-mode]')).toHaveText('Visitor active');

  await Promise.all([
    page.evaluate(() => window.denProfileModeFixture.addVisitorWatchlist(1, 'One')),
    other.evaluate(() => window.denProfileModeFixture.addVisitorWatchlist(2, 'Two')),
  ]);
  for (const tab of [page, other]) {
    await expect
      .poll(() => tab.evaluate(() => window.denProfileModeFixture.snapshot().watchlist.sort()))
      .toEqual(['One', 'Two']);
  }

  await page.getByRole('button', { name: 'Switch profile, current Visitor' }).click();
  await page.getByRole('button', { name: 'Use Owner' }).click();
  await expect(other.locator('[data-mode]')).toHaveText('Owner active');
  await expect(
    other.evaluate(() => window.denProfileModeFixture.addVisitorWatchlist(3, 'Three')),
  ).resolves.toBe('inactive');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith(`den.profile.visitor.v1:${id}:`),
          ),
        visitId,
      ),
    )
    .toEqual([]);
  await other.close();
});
