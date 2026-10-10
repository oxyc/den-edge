import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// Settings › Sharing › Your guests: every per-guest control sits behind one ⋯ menu, so the row is the name and
// where they stand, and nothing overflows a 320px screen.

const grant = (over = {}) => ({
  gid: 'g1',
  name: 'Alex',
  status: 'active',
  addons: ['scout'],
  createdAt: Date.now(),
  codeExpiresAt: Date.now() + 86_400_000,
  accessDays: 7,
  accessUntil: null,
  redeemedAt: Date.now() - 86_400_000,
  expiresAt: Date.now() + 5 * 86_400_000,
  devices: 1,
  deviceCount: 1,
  lastUsedAt: null,
  playsTotal: 0,
  hoursTotal: 0,
  playsThisMonth: 0,
  hoursThisMonth: 0,
  ...over,
});

async function open(page) {
  const calls = [];
  let current = grant();
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [current] } }));
  await page.route('**/lib/*/grants/*', (route) => {
    const request = route.request();
    calls.push({ method: request.method(), body: request.postDataJSON?.() ?? null });
    if (request.method() === 'PUT') {
      current = { ...current, ...request.postDataJSON() };
      return route.fulfill({ json: { grant: current } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${E2E_ORIGIN}/test/sharing-copy.html`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  await expect(page.locator('li.guest-line')).toBeVisible();
  return calls;
}

const NEW_CODE = 'a1b2c3d4.BBBBBBBBBBBBBBBBBBBBBB';

/** Opens the guest list with `POST …/code` answered by `reply`, and returns the code calls it saw. */
async function openWithNewLink(page, current, reply) {
  const posts = [];
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: E2E_ORIGIN });
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [current] } }));
  await page.route('**/lib/*/grants/*/code', (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill(reply(current));
  });
  await page.goto(`${E2E_ORIGIN}/test/sharing-copy.html`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  await expect(page.locator('li.guest-line')).toBeVisible();
  return posts;
}

for (const width of [390, 1280]) {
  test(`New link at ${width}px shows the new link, copyable, and says the old one is dead`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const posts = await openWithNewLink(page, grant(), (g) => ({
      json: { code: NEW_CODE, devicesRaised: false, grant: g },
    }));
    await page.getByRole('button', { name: 'More actions for Alex' }).click();
    await page.getByRole('menuitem', { name: 'New link' }).click();

    const panel = page.getByRole('status').filter({ hasText: 'Alex’s new link.' });
    await expect(panel).toContainText('The previous link no longer works.');
    await expect(panel).not.toContainText('device limit');
    await expect(panel.getByLabel('Invite link')).toHaveValue(`${E2E_ORIGIN}/#invite=${NEW_CODE}`);
    await expect(panel.getByLabel('Invite code')).toHaveValue(NEW_CODE);
    await panel.getByRole('button', { name: 'Copy link' }).click();
    await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${E2E_ORIGIN}/#invite=${NEW_CODE}`,
    );
    expect(posts).toHaveLength(1);
    expect(typeof posts[0].codeExpiresAt).toBe('number');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test(`New link at ${width}px says when the device limit went up`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openWithNewLink(page, grant(), (g) => ({
      json: { code: NEW_CODE, devicesRaised: true, grant: { ...g, devices: 2 } },
    }));
    await page.getByRole('button', { name: 'More actions for Alex' }).click();
    await page.getByRole('menuitem', { name: 'New link' }).click();
    const panel = page.getByRole('status').filter({ hasText: 'Alex’s new link.' });
    await expect(panel).toContainText('The previous link no longer works.');
    await expect(panel).toContainText('the device limit went up by one, to 2');
    await expect(page.locator('li.guest-line')).toContainText('1 of 2 devices');
  });

  test(`New link at ${width}px explains a guest that is already at the most devices`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await openWithNewLink(page, grant({ devices: 5, deviceCount: 5 }), () => ({
      status: 409,
      json: { error: 'devices_full' },
    }));
    await page.getByRole('button', { name: 'More actions for Alex' }).click();
    await page.getByRole('menuitem', { name: 'New link' }).click();
    await expect(page.getByRole('alert')).toContainText('already has all 5 devices');
    await expect(page.getByRole('status').filter({ hasText: 'new link.' })).toHaveCount(0);
  });
}

for (const width of [320, 390, 1280]) {
  test(`guest row at ${width}px keeps its status visible and its controls in the menu`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const calls = await open(page);

    const row = page.locator('li.guest-line');
    await expect(row).toContainText('Active · ends in');
    await expect(row).toContainText('1 of 1 device');
    // No control is inline: no select, and no button but the ⋯.
    await expect(row.locator('select')).toHaveCount(0);
    await expect(row.getByRole('button')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    const more = page.getByRole('button', { name: 'More actions for Alex' });
    await more.click();
    const menu = page.getByRole('menu', { name: 'More actions for Alex' });
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Extend by 7 days' })).toBeVisible();

    // Escape closes it and focus returns to the trigger.
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();

    // The device limit still changes.
    await more.click();
    await menu.getByRole('menuitemradio', { name: 'Allow 3 devices' }).click();
    await expect(row).toContainText('1 of 3 devices');
    expect(calls.some((call) => call.method === 'PUT' && call.body.devices === 3)).toBe(true);
    await expect(more).toBeFocused();

    // Revoke asks first; Cancel keeps the guest and returns focus to the trigger.
    await more.click();
    await menu.getByRole('menuitem', { name: 'Revoke access…' }).click();
    const question = page.getByRole('group', { name: 'Revoke Alex’s access?' });
    await expect(question).toBeVisible();
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(question).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await menu.getByRole('menuitem', { name: 'Revoke access…' }).click();
    await page
      .getByRole('group', { name: 'Revoke Alex’s access?' })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(row).toContainText('Revoked');
    await expect(more).toHaveCount(0);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
