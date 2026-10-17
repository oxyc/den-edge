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
  // The click only starts the invite; its POST leaves after the page has prepared it. Its answer comes from the
  // route above, so once it arrives `posted` holds what was sent.
  const create = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/lib\/[^/]+\/grants$/.test(response.url()),
  );
  await page.getByRole('button', { name: 'Create invite' }).click();
  await create;

  expect(posted).toMatchObject({
    name: 'Alex',
    addons: ['den', 'atlas'],
    installs: { den: 'hearthcfg789', atlas: 'atlascfg456' },
  });
  expect(posted.addons).not.toContain('scout');
  expect(posted.addons).not.toContain('reel');
  await expect(page.getByLabel('Invite link')).toBeVisible();
  await expect(page.getByText(/testcfg123|atlascfg456|hearthcfg789/)).toHaveCount(0);
});
