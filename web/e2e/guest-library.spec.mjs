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
  // This browser is launched here rather than by the runner: the runner traces its pages but keeps none of them in
  // the test's trace. A failure saves each page's own, since the failure these tests have had only on CI is a page's
  // state.
  const contexts = [];
  try {
    await use(browser, async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      contexts.push(context);
      const page = await context.newPage();
      await routeGuestEdge(page, edge);
      return page;
    });
  } catch (error) {
    for (const [n, context] of contexts.entries())
      await context.tracing
        .stop({ path: test.info().outputPath(`page-${n + 1}-trace.zip`) })
        .catch(() => undefined);
    throw error;
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
  // `aria-pressed` is optimistic. Wait for the save indicator to clear before the hard navigation below tears down
  // this page and its Worker; otherwise the test can interrupt the IndexedDB write it expects the invite to move.
  await expect(watchlist).not.toHaveAttribute('data-saving', 'true');
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

    // The guest's synthetic library link is not a TV receiver. Browser playback is offered through the host's
    // stable Hearth facade, whose Remux fallback stays behind the grant-authenticated Edge relay.
    await laptop.goto(`${E2E_ORIGIN}/movie/1002`);
    await expect(laptop.getByRole('link', { name: 'Play', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(laptop.getByRole('button', { name: 'Play on TV', exact: true })).toHaveCount(0);
    await expect.poll(() => edge.playbackProbes.length).toBeGreaterThan(0);
    const probe = edge.playbackProbes.at(-1);
    expect(probe.url).not.toContain('secret');
    expect(probe.headers['x-den-grant']).toMatch(new RegExp(`^${GID}:`));
    expect(probe.headers['x-den-library-member']).toBeUndefined();
  });
});

for (const profiles of [false, true]) {
  test(`a synced ${profiles ? 'profile ' : ''}library keeps its interface language after reload`, async () => {
    const edge = newEdge({ profiles });
    await browserOf(edge, async (_browser, open) => {
      const laptop = await laptopAcceptingAnInvite(open, edge);
      if (profiles) {
        await expect(
          laptop.getByRole('button', { name: 'Switch profile, current Owner' }),
        ).toBeVisible({ timeout: 30_000 });
        // Finish the migration journey first. The hosted regression is a returning profile whose activity library
        // is restored at startup, not the one-time legacy Owner session retained while a split is committing.
        await laptop.reload();
        await expect(
          laptop.getByRole('button', { name: 'Switch profile, current Owner' }),
        ).toBeVisible({ timeout: 30_000 });
      }

      await laptop.goto(`${E2E_ORIGIN}/settings`);
      const language = laptop.getByRole('combobox', {
        name: 'Interface language',
        exact: true,
      });
      await expect(language).toBeEnabled({ timeout: 30_000 });
      const saved = laptop.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/batch') &&
          response.ok(),
        { timeout: 30_000 },
      );
      await language.selectOption('es');
      await saved;
      await expect(language).toHaveValue('es');
      await expect(laptop.locator('html')).toHaveAttribute('lang', 'es');
      await expect(laptop.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeVisible();

      await laptop.reload();
      await expect(laptop.locator('html')).toHaveAttribute('lang', 'es', { timeout: 30_000 });
      await expect(laptop.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeVisible();
      await expect(
        laptop.getByRole('combobox', { name: 'Idioma de la interfaz', exact: true }),
      ).toHaveValue('es', { timeout: 30_000 });
    });
  });
}

test('a page opened while the invite moves the library stays open when the move finishes', async () => {
  const edge = newEdge();
  await browserOf(edge, async (_browser, open) => {
    const laptop = await open();
    await laptop.goto(`${E2E_ORIGIN}/`);
    await laptop.getByRole('button', { name: 'Look around instead' }).click();
    await laptop.goto(`${E2E_ORIGIN}/movie/1002`);
    const watchlist = laptop.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.click();
    await expect(watchlist).not.toHaveAttribute('data-saving', 'true');
    // The move waits on the grant's reservation, held here until the guest has gone on to another page.
    let reserving = false;
    let release;
    const reserved = new Promise((resolve) => (release = resolve));
    await laptop.route(`${E2E_ORIGIN}/grant/library`, async (route) => {
      reserving = true;
      await reserved;
      await route.fallback();
    });
    await laptop.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
    await laptop
      .getByRole('dialog', { name: 'Accept this invite?' })
      .getByRole('button', { name: 'Accept' })
      .click();
    await expect.poll(() => reserving, { timeout: 30_000 }).toBe(true);
    await laptop.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(laptop.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    release();
    await expect
      .poll(async () => (await stored(laptop, 'den.links'))?.[0]?.guest, { timeout: 30_000 })
      .toBe(true);
    // The library moved under the same viewer: not a profile switch, so nothing sends the guest Home.
    await expect(laptop.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    expect(new URL(laptop.url()).pathname).toBe('/settings');
  });
});

test('an invite accepted before this browser’s library has opened still moves it at once', async () => {
  const edge = newEdge();
  await browserOf(edge, async (_browser, open) => {
    const laptop = await open();
    await laptop.goto(`${E2E_ORIGIN}/`);
    await laptop.getByRole('button', { name: 'Look around instead' }).click();
    await laptop.goto(`${E2E_ORIGIN}/movie/1002`);
    const watchlist = laptop.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.click();
    await expect(watchlist).not.toHaveAttribute('data-saving', 'true');
    // This browser's own library opens in the page's first library Worker. It is held until the invited library has
    // asked den-edge for its rows, so the move starts while the library it moves is still opening.
    let release;
    const invitedOpened = new Promise((resolve) => (release = resolve));
    await laptop.route(`${E2E_ORIGIN}/lib/**`, async (route) => {
      release();
      await route.fallback();
    });
    let first = true;
    // The Worker's entry module only, as the dev server (`.ts`) and a build (`-<hash>.js`) name it.
    const workerEntry = (url) => /\/libraryServiceWorker(?:\.ts|-[\w-]+\.js)$/.test(url.pathname);
    await laptop.route(workerEntry, async (route) => {
      if (first) {
        first = false;
        await invitedOpened;
      }
      await route.fallback();
    });
    await laptop.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
    await laptop
      .getByRole('dialog', { name: 'Accept this invite?' })
      .getByRole('button', { name: 'Accept' })
      .click();
    // A move that gave up would be tried again only after 30 s; this one finishes on its first try.
    await expect
      .poll(async () => (await stored(laptop, 'den.links'))?.[0]?.guest, { timeout: 15_000 })
      .toBe(true);
    await expect.poll(() => [...edge.libraries.values()][0]?.rows.size ?? 0).toBeGreaterThan(0);
  });
});

test('a TV camera link opens the exact shared-grant confirmation without keeping its code in the URL', async () => {
  const edge = newEdge({ devices: 2 });
  await browserOf(edge, async (_browser, open) => {
    const phone = await laptopAcceptingAnInvite(open, edge);
    await phone.goto(`${E2E_ORIGIN}/settings#tv=ABCD-EFGH-JKLM`);
    await phone.getByRole('button', { name: /Linked devices/ }).click();
    const devices = phone.getByRole('region', { name: 'Linked devices' });
    await expect(devices.getByText('This TV is waiting.')).toBeVisible();
    await expect(devices.getByLabel('Code shown on TV')).toHaveValue('ABCD-EFGH-JKLM');
    await expect(devices.getByLabel('Shared access for this TV')).toHaveValue(GID);
    await expect(devices.getByRole('button', { name: 'Link this TV' })).toBeEnabled();
    await expect(phone).toHaveURL(`${E2E_ORIGIN}/settings`);
  });
});

test('on a profile host an invite starts the guest’s own profile household', async () => {
  const edge = newEdge({ profiles: true });
  await browserOf(edge, async (_browser, open) => {
    const laptop = await laptopAcceptingAnInvite(open, edge);

    const switcher = laptop.getByRole('button', { name: 'Switch profile, current Owner' });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    await switcher.click();
    const profiles = laptop.getByRole('dialog', { name: 'Who’s watching?' });
    await expect(profiles.getByRole('button', { name: 'Use Owner' })).toBeVisible();
    await expect(profiles.getByRole('button', { name: 'Use Kids' })).toBeVisible();
    await expect(profiles.getByRole('button', { name: 'Use Visitor' })).toBeVisible();

    expect(edge.libraries.size, 'household, Owner and default Kid belong to the guest').toBe(3);
    expect(edge.refusedStarts, 'the grant reserved the household first write').toBe(0);
    expect((await stored(laptop, 'den.links'))[0]).toMatchObject({ guest: true });
  });
});

test('a profile household this browser saw bootstrapped reopens on wire 5 without the 426', async () => {
  const edge = newEdge({ profiles: true });
  await browserOf(edge, async (_browser, open) => {
    const laptop = await laptopAcceptingAnInvite(open, edge);
    const switcher = laptop.getByRole('button', { name: 'Switch profile, current Owner' });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    const households = [...edge.libraries].filter(([, library]) => library.wireMin === 5);
    expect(households, 'only the household is fenced to wire 5').toHaveLength(1);
    const [household] = households[0];
    const opened = () =>
      edge.libraryRequests.filter(({ id, action }) => id === household && action === 'changes');
    // Once the invite made it a profile household, the page opened it on wire 4, was refused, and bootstrapped.
    expect(opened().some(({ wire }) => wire === '4')).toBe(true);
    expect(opened().some(({ wire }) => wire === '5')).toBe(true);
    expect(edge.refused).toBeGreaterThan(0);

    // Seen bootstrapped once, it opens on wire 5 first on every load, and nothing is refused.
    for (let load = 0; load < 2; load++) {
      edge.libraryRequests.length = 0;
      edge.refused = 0;
      await laptop.goto(`${E2E_ORIGIN}/`);
      await expect(switcher).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => opened().length).toBeGreaterThan(0);
      expect(new Set(opened().map(({ wire }) => wire))).toEqual(new Set(['5']));
      expect(edge.refused).toBe(0);
    }
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
    await expect(done).toContainText('Your shared addons are on this phone too');
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
    await expect(done).toContainText('Ask for another device');
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
