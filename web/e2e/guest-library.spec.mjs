// A guest's own library (oxyc/den-edge#390), through the real app and one in-memory den-edge shared by two browsers:
// accepting an invite starts the library and moves what the browser saved into it at once; "Use Den on your phone"
// pairs a second browser with the first (the link carries a pairing code, never the library key, and the laptop
// asks before it hands anything over), and brings the host's addons if a device is free; and ending the grant takes
// the host's addons away without touching the library.
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, GID, newEdge, routeGuestEdge } from './guest-edge.mjs';

async function browserOf(edge, use) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    await use(browser, async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      const page = await context.newPage();
      await routeGuestEdge(page, edge);
      return page;
    });
  } finally {
    await browser.close();
  }
}

const stored = (page, key) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), key);

/** The guest's laptop: a title on the watchlist while the browser has only its own library, then the invite accepted. */
async function laptopAcceptingAnInvite(open, edge) {
  const laptop = await open();
  // A visitor looking around has a library of its own, kept in this browser only.
  await laptop.goto(`${E2E_ORIGIN}/`);
  await laptop.getByRole('button', { name: 'Look around instead' }).click();
  await laptop.goto(`${E2E_ORIGIN}/movie/1002`);
  const watchlist = laptop.getByRole('button', { name: 'Watchlist', exact: true });
  await watchlist.click();
  await expect(watchlist).toHaveAttribute('aria-pressed', 'true');
  expect(edge.libraries.size, 'nothing synced yet: it is the browser’s own').toBe(0);

  await laptop.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await laptop
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect
    .poll(async () => (await stored(laptop, 'den.links'))?.[0]?.guest, { timeout: 30_000 })
    .toBe(true);
  return laptop;
}

/** The laptop's "Use Den on your phone" link, with the laptop left on the page that will ask to allow the phone. */
async function phoneLinkOf(laptop) {
  await laptop.goto(`${E2E_ORIGIN}/settings#phone`);
  const row = laptop.locator('#phone');
  await row
    .getByRole('button', { name: /Use Den on your phone/ })
    .first()
    .click();
  await row.getByRole('button', { name: 'Use Den on your phone', exact: true }).click();
  const link = await row.getByLabel('Phone link').inputValue();
  await expect(row.getByRole('img', { name: 'QR code to scan with your phone' })).toBeVisible();
  return { link, row };
}

const allow = (laptop) =>
  laptop.getByRole('alertdialog', { name: 'Allow this phone?' }).getByRole('button', {
    name: 'Allow this phone',
  });

test('accepting an invite starts the guest’s library with the watchlist already in it', async () => {
  const edge = newEdge();
  await browserOf(edge, async (_browser, open) => {
    const laptop = await laptopAcceptingAnInvite(open, edge);
    // The library exists at den-edge, started by the grant's reservation, with the saved title in it.
    await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => [...edge.libraries.values()][0].rows.size).toBeGreaterThan(0);
    expect(edge.refusedStarts).toBe(0);
    // Reloaded onto the synced library, the title is still on the watchlist.
    await laptop.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(laptop.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
      timeout: 30_000,
    });
  });
});

test('the phone link pairs the phone with the laptop, which allows it, and the grant ending leaves the library', async () => {
  const edge = newEdge({ devices: 2 });
  await browserOf(edge, async (_browser, open) => {
    const laptop = await laptopAcceptingAnInvite(open, edge);
    await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);

    const { link } = await phoneLinkOf(laptop);
    expect(link).toMatch(/#phone=a1b2c3d4\.[A-Za-z0-9_-]{22}&code=[A-Z2-9]{12}$/);
    const key = (await stored(laptop, 'den.links'))[0].libraryKey;
    const base64url = key.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    expect(link, 'the library key is not in the link').not.toContain(base64url);
    expect(link).not.toContain('k=');

    const phone = await open();
    await phone.goto(link);
    await expect.poll(() => new URL(phone.url()).hash, 'the link leaves the address').toBe('');
    // Nothing is handed over until the laptop says so.
    const waiting = phone.getByRole('dialog', { name: 'Setting up Den on this phone' });
    await expect(waiting).toBeVisible({ timeout: 30_000 });
    await expect(allow(laptop)).toBeVisible({ timeout: 30_000 });
    expect(await stored(phone, 'den.links')).toBeNull();
    await allow(laptop).click();

    const done = phone.getByRole('dialog', { name: 'Your library is on this phone' });
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toContainText('Oskar’s addons are on this phone too');
    await done.getByRole('button', { name: 'Open Den' }).click();

    await expect.poll(async () => (await stored(phone, 'den.grants'))?.[0]?.gid).toBe(GID);
    expect(edge.grant.devices.size, 'the phone took a slot of its own').toBe(2);
    expect((await stored(phone, 'den.links'))[0].guest).toBe(true);
    await phone.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(phone.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
      timeout: 30_000,
    });

    // The same link a second time is dead: its pairing was used.
    const again = await open();
    await again.goto(link);
    await expect(again.getByRole('dialog', { name: 'Couldn’t finish' })).toContainText(
      'already used',
      { timeout: 30_000 },
    );
    expect(await stored(again, 'den.links')).toBeNull();
    expect(edge.grant.devices.size).toBe(2);

    // The host removes the guest: the addons go, the library does not.
    edge.grant.live = false;
    await laptop.goto(`${E2E_ORIGIN}/movie/1003`);
    const second = laptop.getByRole('button', { name: 'Watchlist', exact: true });
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => [...edge.libraries.values()][0].rows.size, { timeout: 30_000 })
      .toBeGreaterThan(1);
    await phone.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(phone.getByRole('link', { name: /Movie 1003/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => (await stored(laptop, 'den.grants'))?.[0]?.ended, { timeout: 30_000 })
      .toBe(true);
  });
});

test('a link whose pairing has lapsed fails on the phone and tells the laptop to make a new one', async () => {
  const edge = newEdge();
  await browserOf(edge, async (_browser, open) => {
    const laptop = await laptopAcceptingAnInvite(open, edge);
    const { link, row } = await phoneLinkOf(laptop);
    edge.expirePairs();
    await expect(row.getByText(/That link has expired/)).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole('button', { name: 'Make a new link' })).toBeVisible();

    const phone = await open();
    await phone.goto(link);
    await expect(phone.getByRole('dialog', { name: 'Couldn’t finish' })).toContainText('expired', {
      timeout: 30_000,
    });
    expect(await stored(phone, 'den.links')).toBeNull();
    expect(edge.grant.devices.size, 'no slot was taken').toBe(1);
  });
});

test('at the device limit the phone still gets the library, without addons, and is told whom to ask', async () => {
  const edge = newEdge({ devices: 1 });
  await browserOf(edge, async (_browser, open) => {
    const laptop = await laptopAcceptingAnInvite(open, edge);
    const { link } = await phoneLinkOf(laptop);

    const phone = await open();
    await phone.goto(link);
    await expect(allow(laptop)).toBeVisible({ timeout: 30_000 });
    await allow(laptop).click();
    const done = phone.getByRole('dialog', { name: 'Your library is on this phone' });
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done).toContainText('Ask Oskar to allow another device');
    await done.getByRole('button', { name: 'Open Den' }).click();

    expect(edge.grant.devices.size, 'no slot was taken').toBe(1);
    expect(await stored(phone, 'den.grants')).toBeNull();
    expect((await stored(phone, 'den.links'))[0].guest).toBe(true);
    await phone.goto(`${E2E_ORIGIN}/watchlist`);
    await expect(phone.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible({
      timeout: 30_000,
    });
  });
});
