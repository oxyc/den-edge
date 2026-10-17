import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

test('a new invite automatically shares every lendable addon and no others', async ({ page }) => {
  let posted = null;
  await page.route('**/lib/*/grants', (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fulfill({ json: { grants: [] } });
    posted = request.postDataJSON();
    return route.fulfill({
      json: {
        code: 'deadbeef.abcdefghijklmnopqrstuv',
        grant: {
          gid: 'g1',
          name: posted.name,
          status: 'invited',
          addons: posted.addons,
          createdAt: Date.now(),
          codeExpiresAt: Date.now() + 86_400_000,
          accessDays: null,
          accessUntil: null,
          redeemedAt: null,
          expiresAt: null,
          devices: 1,
          deviceCount: 0,
          lastUsedAt: null,
          playsTotal: 0,
          hoursTotal: 0,
          playsThisMonth: 0,
          hoursThisMonth: 0,
        },
      },
    });
  });

  await page.goto(`${E2E_ORIGIN}/test/sharing-copy.html`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();

  await expect(page.getByText('Addons to share', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByLabel('Guest’s name').fill('Alex');
  await page.getByRole('button', { name: 'Create invite' }).click();

  expect(posted).toMatchObject({
    name: 'Alex',
    addons: ['scout', 'atlas'],
    installs: { scout: 'testcfg123', atlas: 'atlascfg456' },
  });
  expect(posted.addons).not.toContain('reel');
  expect(posted.addons).not.toContain('den');
  await expect(page.getByLabel('Invite link')).toBeVisible();
  await expect(page.getByText(/testcfg123|atlascfg456/)).toHaveCount(0);
});
