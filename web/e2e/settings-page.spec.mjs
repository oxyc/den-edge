import { test, expect, chromium } from '@playwright/test';
import { guardNetwork, routeTmdb } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const PROVIDERS = {
  movie: [
    { provider_id: 8, provider_name: 'Netflix', display_priority: 1 },
    { provider_id: 323, provider_name: 'Yle Areena', display_priority: 2 },
    { provider_id: 2, provider_name: 'Apple TV Store', display_priority: 9 },
  ],
  tv: [
    { provider_id: 8, provider_name: 'Netflix', display_priority: 1 },
    { provider_id: 323, provider_name: 'Yle Areena', display_priority: 2 },
    { provider_id: 1773, provider_name: 'SkyShowtime', display_priority: 4 },
  ],
};

async function markPageFetch(page) {
  await page.addInitScript(() => {
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  });
}

for (const width of [320, 390, 820, 1280]) {
  test(`Settings covers the TV's sections, opens rows in place and saves at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
        locale: 'fi-FI',
      });
      await context.addInitScript(() => {
        const fixtureLibraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
        // Its own name: on a Mac the page guesses "Mac", the seeded device's name.
        localStorage.setItem('den.deviceName', 'Test Browser');
        localStorage.setItem(
          'den.links',
          JSON.stringify([
            {
              inboxKey: 'deadbeefcafe1234',
              name: 'Living Room TV',
              linkedAt: 4000,
              libraryKey: fixtureLibraryKey,
              linkKey: 'fixture',
              deviceId: 'aaaa000000000001',
            },
            {
              inboxKey: 'feedface00001234',
              name: 'Cabin TV',
              linkedAt: 3000,
              libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
              linkKey: 'fixture-2',
            },
          ]),
        );
        localStorage.setItem(
          'den.shared',
          JSON.stringify([
            {
              name: 'Mac',
              at: 8000,
              libraryKey: fixtureLibraryKey,
              deviceId: 'bbbb000000000002',
            },
            { name: 'Phone', at: 8500, libraryKey: fixtureLibraryKey },
          ]),
        );
      });
      const page = await context.newPage();
      await guardNetwork(page);
      await markPageFetch(page);
      await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
      const pageOwnedProviders = [];
      await page.route('**/routes', (r) => r.fulfill({ json: {} }));
      await page.route('**/version', (r) => r.fulfill({ json: { version: '0.67.0' } }));
      await page.route('**/config', (r) => r.fulfill({ json: { simklClientId: 'client-1' } }));
      await routeTmdb(page, (route) => {
        if (route.request().headers()['x-den-test-fetch-realm'])
          pageOwnedProviders.push(route.request().url());
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/configuration')) return route.fulfill({ json: { images: {} } });
        if (url.pathname.endsWith('/watch/providers/regions'))
          return route.fulfill({
            json: {
              results: [
                { iso_3166_1: 'FI', english_name: 'Finland' },
                { iso_3166_1: 'SE', english_name: 'Sweden' },
                { iso_3166_1: 'US', english_name: 'United States of America' },
              ],
            },
          });
        const kind = url.pathname.endsWith('/tv') ? 'tv' : 'movie';
        return route.fulfill({ json: { results: PROVIDERS[kind] } });
      });
      await page.goto(`${E2E_ORIGIN}/test/settings.html`);

      const expectViewportWidth = async () =>
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      for (const section of ['Connections', 'Playback', 'Content', 'Advanced', 'About'])
        await expect(page.getByRole('heading', { name: section, level: 2 })).toBeVisible();
      // Playback and Content lead the page, ahead of Connections.
      const sections = await page.getByRole('heading', { level: 2 }).allTextContents();
      expect(sections.slice(0, 3)).toEqual(['Playback', 'Content', 'Connections']);
      expect(sections.slice(-2)).toEqual(['Advanced', 'About']);
      await expect(page.locator('#playback-source-policy select')).toHaveValue('remember');
      await expectViewportWidth();

      // The seeded library, said the way the TV's rows say it.
      await expect(page.getByRole('button', { name: /Hidden genres/ })).toContainText('2');
      await expect(page.getByRole('button', { name: /Parental controls/ })).toContainText('PG-13');
      await expect(page.getByRole('button', { name: /TMDB key/ })).toContainText('Connected');

      // With den-edge publishing SIMKL's client id, SIMKL connects from here too.
      await page.getByRole('button', { name: /SIMKL Not connected/ }).click();
      await expect(
        page.getByRole('region', { name: 'SIMKL' }).getByRole('button', { name: 'Connect SIMKL' }),
      ).toBeVisible();

      // A row opens in place, and its choices save to the library.
      await page.getByRole('button', { name: /Hidden genres/ }).click();
      const genres = page.getByRole('region', { name: 'Hidden genres' });
      await expect(genres).toContainText('2 hidden · Anime, Horror');
      await genres.getByRole('group', { name: 'Movies' }).getByText('Comedy').click();
      await expect(genres).toContainText('3 hidden · Anime, Comedy, Horror');

      // My services: the country's directory, with the pick already ticked.
      await page.getByRole('button', { name: /My services/ }).click();
      const services = page.getByRole('region', { name: 'My services' });
      const netflix = services.getByRole('checkbox', { name: /Netflix/ });
      await expect(netflix).toBeChecked();
      await expect(services.getByText('(series only)')).toBeVisible();
      if (width === 1280) {
        await netflix.focus();
        await page.keyboard.press('Space');
        await expect(netflix).not.toBeChecked();
        await expect(netflix).toBeFocused();
      }
      await expectViewportWidth();

      // Parental controls stay locked behind the PIN.
      await page.getByRole('button', { name: /Parental controls/ }).click();
      const parental = page.getByRole('region', { name: 'Parental controls' });
      await expect(parental.getByRole('radio', { name: 'R' })).toBeDisabled();
      await parental.getByLabel('Parental PIN').fill('1234');
      await expect(parental.getByRole('radio', { name: 'R' })).toBeEnabled();

      // A delete asks first, in place.
      await page.getByRole('button', { name: /Plugins/ }).click();
      const plugins = page.getByRole('region', { name: 'Plugins' });
      const pluginActions = plugins.getByRole('button', { name: /More actions for/ });
      await expect(pluginActions).toBeVisible();
      await pluginActions.click();
      await page.getByRole('menuitem', { name: 'Remove add-on…' }).click();
      await expect(plugins.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(pluginActions).toBeVisible();

      await page.getByRole('button', { name: /Linked devices/ }).click();
      const devices = page.getByRole('region', { name: 'Linked devices' });
      await expect(devices.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
      await expect(
        devices.getByRole('heading', { name: 'Devices with your library', exact: true }),
      ).toHaveCount(0);
      await expect(
        devices.getByRole('heading', { name: 'Linked to this browser', exact: true }),
      ).toHaveCount(0);
      // Linked devices and a shared library: nothing to join, and sign out and recovery live under Advanced.
      for (const gone of [
        'Your library',
        'Join another library',
        'Recovery code',
        'Name of this device',
      ])
        await expect(devices.getByRole('heading', { name: gone, exact: true })).toHaveCount(0);
      const linkedDeviceHeadings = await devices
        .getByRole('heading', { level: 3 })
        .allTextContents();
      expect(linkedDeviceHeadings.indexOf('Link a TV')).toBe(
        linkedDeviceHeadings.indexOf('Devices') + 1,
      );
      expect(linkedDeviceHeadings.indexOf('Link another device')).toBe(
        linkedDeviceHeadings.indexOf('Link a TV') + 1,
      );
      // A Library v4 library is cut off from here: the reset asks first, and says what it costs.
      await devices.getByRole('button', { name: 'Reset library key…' }).click();
      await expect(devices).toContainText('must pair again with a code');
      await expect(devices.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.keyboard.press('Escape');
      for (const gone of ['Libraries this browser opens', 'handoff', 'linked', 'Library v3'])
        await expect(devices).not.toContainText(gone);
      // A synced device and this browser's way into its library are separate rows with separate actions.
      const listed = devices.getByRole('listitem');
      const tv = listed.filter({ hasText: 'Living Room TV' });
      await expect(tv).toHaveCount(1);
      await expect(tv).toContainText('TV · seen');
      const removeTv = tv.getByRole('button', { name: 'Remove Living Room TV' });
      await expect(removeTv).toBeVisible();
      const deviceRowGeometry = await tv.evaluate((row) => {
        const label = row.querySelector('.label')?.getBoundingClientRect();
        const action = row.querySelector('button')?.getBoundingClientRect();
        return label && action
          ? {
              labelCenter: label.top + label.height / 2,
              actionCenter: action.top + action.height / 2,
              actionWidth: action.width,
            }
          : null;
      });
      expect(deviceRowGeometry).not.toBeNull();
      expect(Math.abs(deviceRowGeometry.labelCenter - deviceRowGeometry.actionCenter)).toBeLessThan(
        2,
      );
      expect(deviceRowGeometry.actionWidth).toBeLessThan(90);
      const mac = listed.filter({ hasText: 'Mac' });
      await expect(mac).toHaveCount(1);
      await expect(mac).toContainText('Browser · seen');
      await expect(mac.getByRole('button')).toHaveCount(1);
      const phone = listed.filter({ hasText: 'Phone' });
      await expect(phone).toContainText('added');
      await expect(phone.getByRole('button', { name: 'Remove Phone' })).toBeVisible();
      // The production shell records itself when its library opens. This direct Settings fixture seeds that same
      // record, so this verifies the rendered linked-device behavior without duplicating the shell lifecycle here.
      const self = listed.filter({ hasText: /This device · seen/ });
      await expect(self).toHaveCount(1);
      await expect(self.getByText('This device', { exact: true })).toBeVisible();
      await expect(self.getByRole('button')).toHaveCount(0);
      // This device's name is edited in its own row, and other rows have no field.
      const nameField = self.getByRole('textbox', { name: 'Name of this device' });
      await expect(nameField).toHaveValue('Test Browser');
      const selfRowGeometry = await self.evaluate((row) => {
        const field = row.querySelector('input')?.getBoundingClientRect();
        const status = row.querySelector('.device-self')?.getBoundingClientRect();
        return field && status
          ? {
              fieldCenter: field.top + field.height / 2,
              statusCenter: status.top + status.height / 2,
            }
          : null;
      });
      expect(selfRowGeometry).not.toBeNull();
      expect(Math.abs(selfRowGeometry.fieldCenter - selfRowGeometry.statusCenter)).toBeLessThan(2);
      await expect(listed.getByRole('textbox')).toHaveCount(1);
      await nameField.fill('Study Browser');
      expect(await page.evaluate(() => localStorage.getItem('den.deviceName'))).toBe(
        'Study Browser',
      );

      // Advanced holds the recovery code and signing out. Libraries are named by whether they're the one open here,
      // not after the TV they came through.
      await page.getByRole('button', { name: /Recovery code/ }).click();
      const recovery = page.getByRole('region', { name: 'Recovery code' });
      await expect(
        recovery.getByRole('heading', { name: 'Open with a recovery code', exact: true }),
      ).toBeVisible();
      await expect(
        recovery.getByRole('heading', { name: 'Recovery code', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: /Sign out/ }).click();
      const signOut = page.getByRole('region', { name: 'Sign out' });
      const open = signOut.getByRole('listitem').filter({ hasText: 'Open on this browser' });
      await expect(open).toContainText('Your library');
      await expect(open.getByRole('button', { name: 'Sign out on this browser' })).toBeVisible();
      const other = signOut.getByRole('listitem').filter({ hasText: 'Another library' });
      await expect(other).toContainText('Saved on this browser · joined through Cabin TV');
      await expect(
        other.getByRole('button', { name: 'Remove the library joined through Cabin TV' }),
      ).toBeVisible();

      // One Remove takes the device off the library's list and drops this browser's record of giving it the library.
      await mac.getByRole('button', { name: 'Remove Mac' }).click();
      await expect(
        devices.getByRole('group', { name: 'Remove Mac from this list?' }),
      ).toContainText('It can still use your library');
      await devices.getByRole('button', { name: 'Remove', exact: true }).click();
      await expect(listed.filter({ hasText: 'Mac' })).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem('den.shared') ?? '[]').map((entry) => entry.name),
        ),
      ).toEqual(['Phone']);

      // The long lists, open for the screenshot: content warnings in their ten groups, and the languages.
      await page.getByRole('button', { name: /Content warnings All/ }).click();
      await expect(
        page.getByRole('region', { name: 'Content warnings' }).getByRole('group', { name: 'Body' }),
      ).toBeVisible();
      await page.getByRole('button', { name: /Hidden languages/ }).click();

      // Ratings are a readable list, rather than turning into several columns on wider settings panels.
      await page.getByRole('button', { name: /Ratings shown/ }).click();
      const ratings = page.getByRole('region', { name: 'Ratings shown' });
      const ratingRows = await ratings.getByRole('checkbox').evaluateAll((checkboxes) =>
        checkboxes.map((checkbox) => {
          const row = checkbox.closest('label')?.getBoundingClientRect();
          return row ? { left: row.left, top: row.top } : null;
        }),
      );
      expect(ratingRows.every(Boolean)).toBe(true);
      expect(new Set(ratingRows.map((row) => Math.round(row.top))).size).toBe(ratingRows.length);
      expect(Math.max(...ratingRows.map((row) => row.left))).toBeCloseTo(
        Math.min(...ratingRows.map((row) => row.left)),
        0,
      );

      // A section's own toggle opens every row in it and closes them again; the page's, every row on the page.
      await page.getByRole('button', { name: 'Expand all in Advanced' }).click();
      await expect(page.getByRole('button', { name: /Diagnostics/ })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await page.getByRole('button', { name: 'Collapse all in Advanced' }).click();
      await expect(page.getByRole('button', { name: /Diagnostics/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await page.getByRole('button', { name: 'Expand all in Settings' }).click();
      await expect(page.getByRole('button', { name: /Terms of Use/ })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.getByRole('button', { name: 'Collapse all in Settings' })).toBeVisible();

      await expectViewportWidth();
      await page.screenshot({
        path: test.info().outputPath(`settings-${width}.png`),
        fullPage: true,
      });
      expect(pageOwnedProviders, 'Settings provider reads must stay inside the Worker').toEqual([]);
    } finally {
      await browser.close();
    }
  });
}

test('retained Settings replaces every household view and sends its next mutation to that authority', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { images: {}, results: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/settings.html?authority-replacement`);

  const openDevices = async () => {
    const button = page.getByRole('button', { name: /Linked devices/ });
    await expect(button).toBeVisible();
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    return page.getByRole('region', { name: 'Linked devices' });
  };

  let devices = await openDevices();
  await expect(devices).toContainText('Living Room TV');
  await expect(page.getByRole('button', { name: /SIMKL Not connected/ })).toBeVisible();

  // Retry replaces the failed selector in place: there is still only one live connections subscription.
  await page.evaluate(() => globalThis.fixtureSettingsAuthority.failConnections());
  await expect(page.getByText('Couldn’t load your settings.')).toBeVisible();
  const playbackInputs = page.locator('#playback select, #playback input');
  await expect(playbackInputs).toHaveCount(6);
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => input.disabled)))
    .toBe(true);
  await expect(
    page.locator('#content, #connections, #sharing, #assistants, #import, #advanced'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => !input.disabled)))
    .toBe(true);
  devices = await openDevices();
  await expect(devices).toContainText('Living Room TV');
  let subscriptions = await page.evaluate(() =>
    globalThis.fixtureSettingsAuthority.subscriptions(),
  );
  expect(subscriptions.primary.connections).toBe(1);
  expect(subscriptions.primary.simkl).toBe(1);
  expect(subscriptions.primary.recovery).toBe(1);

  // Capture real old-authority publications before replacement, then deliver them after its leases are released.
  await page.evaluate(() => globalThis.fixtureSettingsAuthority.holdOldSelections());
  await page.evaluate(() => globalThis.fixtureSettingsAuthority.replace());
  devices = await openDevices();
  await expect(devices).toContainText('Kitchen TV');
  await expect(devices).not.toContainText('Living Room TV');
  await expect(page.getByRole('button', { name: /SIMKL Connected/ })).toBeVisible();

  await page.evaluate(() => globalThis.fixtureSettingsAuthority.releaseOldSelections());
  await expect(devices).toContainText('Kitchen TV');
  await expect(page.getByRole('button', { name: /SIMKL Connected/ })).toBeVisible();
  subscriptions = await page.evaluate(() => globalThis.fixtureSettingsAuthority.subscriptions());
  expect(subscriptions.primary.connections ?? 0).toBe(0);
  expect(subscriptions.primary.simkl ?? 0).toBe(0);
  expect(subscriptions.primary.recovery ?? 0).toBe(0);
  expect(subscriptions.replacement.connections).toBe(1);
  expect(subscriptions.replacement.simkl).toBe(1);
  expect(subscriptions.replacement.recovery).toBe(1);

  await devices.getByRole('button', { name: 'Remove Kitchen TV' }).click();
  await expect(
    devices.getByRole('group', { name: 'Remove Kitchen TV from this list?' }),
  ).toBeVisible();
  await devices.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(devices).not.toContainText('Kitchen TV');
  expect(await page.evaluate(() => globalThis.fixtureSettingsAuthority.commands())).toEqual({
    primary: [],
    replacement: ['device.remove'],
  });

  await page.evaluate(() => globalThis.fixtureSettingsAuthority.unmount());
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toHaveCount(0);
  subscriptions = await page.evaluate(() => globalThis.fixtureSettingsAuthority.subscriptions());
  expect(subscriptions.replacement.connections ?? 0).toBe(0);
  expect(subscriptions.replacement.simkl ?? 0).toBe(0);
  expect(subscriptions.replacement.recovery ?? 0).toBe(0);
});

test('profile Owner tracker state and mutations use activity authority, never the household log', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { images: {}, results: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profile-tracker-authority`);

  // The household has no tracker row. The connected presentation comes only from Owner's activity library.
  await expect(page.getByRole('button', { name: /Trakt Unavailable/ })).toBeVisible();
  await page.getByRole('button', { name: /Trakt Unavailable/ }).click();
  await expect(page.getByRole('region', { name: 'Trakt' })).toContainText(
    'Den does not send watch history to Trakt from Web or Apple TV.',
  );
  const simkl = page.getByRole('button', { name: /SIMKL Connected/ });
  await expect(simkl).toBeVisible();
  await simkl.click();
  const section = page.getByRole('region', { name: 'SIMKL' });
  await section.getByRole('button', { name: 'Disconnect' }).click();
  await section.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureTrackerAuthority.commands()))
    .toEqual({ owner: ['disconnect'], replacement: [] });

  // Replace only the active Owner activity library while that old mutation is held. Its tracker lease retires and
  // the preserved disclosure immediately presents the replacement authority; releasing the old answer cannot
  // republish its state or touch the household log.
  await page.evaluate(() => globalThis.fixtureTrackerAuthority.replace());
  const replacementSimkl = page.getByRole('button', { name: /SIMKL 1 removal held/ });
  await expect(replacementSimkl).toBeEnabled();
  const replacementSection = page.getByRole('region', { name: 'SIMKL' });
  await expect(replacementSection).toContainText('Movie 550');
  await expect(replacementSection).toContainText('Remove 1 title from SIMKL');
  // The held-removal row value, the title fallback and the confirmation follow the interface language.
  await page.evaluate(() => globalThis.fixtureInterfaceLanguage('es'));
  await expect(page.getByRole('button', { name: /1 eliminación en espera/ })).toBeVisible();
  const localizedSection = page.locator('#simkl-panel');
  await expect(localizedSection).toContainText('Película 550');
  await expect(localizedSection).toContainText('Quitar 1 título de SIMKL');
  await page.evaluate(() => globalThis.fixtureInterfaceLanguage('en'));
  await expect(replacementSimkl).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureTrackerAuthority.subscriptions()))
    .toEqual({ owner: 0, replacement: 1 });
  await page.evaluate(() => globalThis.fixtureTrackerAuthority.release());
  await expect(replacementSimkl).toBeVisible();
  await replacementSection.getByRole('button', { name: 'Disconnect' }).click();
  await replacementSection.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(replacementSection).toContainText(
    'SIMKL connection is unavailable in this deployment.',
  );
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureTrackerAuthority.commands()))
    .toEqual({ owner: ['disconnect'], replacement: ['disconnect'] });
  expect(await page.evaluate(() => globalThis.fixtureTrackerAuthority.householdCommands())).toEqual(
    [],
  );

  // This profile has no Web SIMKL client id and its Apple TV route is deliberately unavailable: never loop the
  // viewer back to TV. Household and activity selector failures are retried independently by the one visible action.
  await page.evaluate(() => {
    globalThis.fixtureSettingsAuthority.failConnections();
    globalThis.fixtureTrackerAuthority.fail();
  });
  await expect(page.getByText('Couldn’t load your settings.')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: /SIMKL Not connected/ })).toBeVisible();
  expect(await page.evaluate(() => globalThis.fixtureTrackerAuthority.retries())).toEqual({
    owner: 0,
    replacement: 1,
  });
});

test('a held profile replacement disables every Playback input and never crosses preference authority', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { images: {}, results: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/settings.html?playback-authority-replacement`);

  const playbackInputs = page.locator('#playback select, #playback input');
  const source = page.locator('#playback-source-policy select');
  await expect(playbackInputs).toHaveCount(6);
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => !input.disabled)))
    .toBe(true);
  await expect(source).toHaveValue('remember');

  await page.evaluate(() => globalThis.fixtureSettingsAuthority.replacePlaybackHeld());
  await expect(page.locator('.settings-load[role="status"]')).toBeVisible();
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => input.disabled)))
    .toBe(true);
  await expect(
    page.locator('#content, #connections, #sharing, #assistants, #import, #advanced'),
  ).toHaveCount(0);

  // Exercise the command guard directly: even a synthetic queued change event at the prop replacement boundary
  // cannot write either the retired profile preferences or the replacement while its authority is still loading.
  await source.evaluate((select) => {
    select.value = 'best';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    await page.evaluate(() => globalThis.fixtureSettingsAuthority.preferenceCommands()),
  ).toEqual({ primary: [], replacement: [] });

  await page.evaluate(() => globalThis.fixtureSettingsAuthority.releasePlaybackReplacement());
  await expect(page.locator('.settings-load')).toHaveCount(0);
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => !input.disabled)))
    .toBe(true);
  await source.selectOption('best');
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureSettingsAuthority.preferenceCommands()))
    .toEqual({ primary: [], replacement: ['best'] });
});

test('a retained profile-policy failure disables Playback and retries its exact activity service', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { images: {}, results: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/settings.html?playback-authority-replacement`);

  const playbackInputs = page.locator('#playback select, #playback input');
  const source = page.locator('#playback-source-policy select');
  await expect(playbackInputs).toHaveCount(6);
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => !input.disabled)))
    .toBe(true);
  await expect(source).toHaveValue('remember');
  await page.evaluate(() => globalThis.fixtureSettingsAuthority.setPresentationLanguage('sv'));
  await page.evaluate(() => globalThis.fixtureSettingsAuthority.failPreferenceSettings());

  const alert = page.locator('.settings-load[role="alert"]');
  await expect(alert).toContainText('Det gick inte att ladda dina inställningar.');
  await expect(alert.getByRole('button', { name: 'Försök igen' })).toBeVisible();
  // The failed root deliberately retains its last value; it remains visible for continuity but never actionable.
  await expect(source).toHaveValue('remember');
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => input.disabled)))
    .toBe(true);
  await expect(
    page.locator('#content, #connections, #sharing, #assistants, #import, #advanced'),
  ).toHaveCount(0);

  await alert.getByRole('button', { name: 'Försök igen' }).click();
  await expect(alert).toHaveCount(0);
  await expect
    .poll(() => playbackInputs.evaluateAll((inputs) => inputs.every((input) => !input.disabled)))
    .toBe(true);
  await expect(
    page.locator('#content, #connections, #sharing, #assistants, #import, #advanced'),
  ).toHaveCount(6);
});

test('a held retired preference save cannot publish language or restore focus into its replacement', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { images: {}, results: [] } }));
  await page.goto(`${E2E_ORIGIN}/test/settings.html?playback-authority-replacement`);

  const language = page.locator('#interface-language select');
  const replacementFocus = page.locator('#playback-source-policy select');
  const documentLanguage = await page.locator('html').getAttribute('lang');
  await expect(language).toBeEnabled();
  await language.focus();
  // Establish keyboard modality before the save captures its focus origin; otherwise there is intentionally no
  // restore candidate and the stale-finally assertion would not exercise the authority fence.
  await language.dispatchEvent('keydown', { key: 'Enter' });
  await language.selectOption('sv');
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureSettingsAuthority.preferencePatchStarted()))
    .toBe(true);

  await page.evaluate(() => globalThis.fixtureSettingsAuthority.replacePlaybackHeld());
  await page.evaluate(() => globalThis.fixtureSettingsAuthority.releasePlaybackReplacement());
  await expect(page.locator('.settings-load')).toHaveCount(0);
  await replacementFocus.focus();
  await expect(replacementFocus).toBeFocused();

  await page.evaluate(() => globalThis.fixtureSettingsAuthority.releasePreferencePatch());
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureSettingsAuthority.preferenceCommands()))
    .toEqual({ primary: ['language:sv'], replacement: [] });
  await expect(replacementFocus).toBeFocused();
  expect(await page.locator('html').getAttribute('lang')).toBe(documentLanguage);
  expect(
    await page.evaluate(() => globalThis.fixtureSettingsAuthority.presentationLanguages()),
  ).toEqual([]);
});

test('a refused SIMKL disconnect stays connected and its localized Retry commits', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await routeTmdb(page, (route) => route.fulfill({ json: { images: {}, results: [] } }));
  await page.goto(
    `${E2E_ORIGIN}/test/settings.html?profile-tracker-authority&tracker-disconnect-fail-once`,
  );

  await page.getByRole('button', { name: /SIMKL Connected/ }).click();
  // The locale catalog may qualify a brand for glossary review; the production row id is the stable identity.
  const section = page.locator('#simkl-panel');
  await page.evaluate(() => globalThis.fixtureInterfaceLanguage('es'));
  await section.getByRole('button', { name: 'Desconectar' }).click();
  await section.getByRole('button', { name: 'Desconectar', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'No se pudo desconectar. Inténtalo de nuevo en unos instantes.',
  );
  expect(
    await page.evaluate(() => globalThis.fixtureTrackerAuthority.views().owner.connected),
  ).toBe(true);

  await section.getByRole('button', { name: 'Reintentar' }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureTrackerAuthority.views().owner.connected))
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => globalThis.fixtureTrackerAuthority.commands()))
    .toEqual({ owner: ['disconnect', 'disconnect'], replacement: [] });
  expect(await page.evaluate(() => globalThis.fixtureTrackerAuthority.householdCommands())).toEqual(
    [],
  );
});

test('saving a provider key validates it in the content Worker before storing it', async ({
  page,
}) => {
  await guardNetwork(page);
  await markPageFetch(page);
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  const checks = [];
  await page.route('**/ratings/check', (route) => {
    checks.push({
      key: route.request().headers()['x-api-key'],
      pageOwned: route.request().headers()['x-den-test-fetch-realm'] !== undefined,
    });
    return route.fulfill({ json: {} });
  });
  await routeTmdb(page, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/configuration')) return route.fulfill({ json: { images: {} } });
    return route.fulfill({ json: { results: [] } });
  });
  await page.goto(`${E2E_ORIGIN}/test/settings.html`);

  await page.getByRole('button', { name: /OMDb key/ }).click();
  const row = page.getByRole('region', { name: 'OMDb key' });
  await row.getByLabel('OMDb key API key').fill('candidate-omdb');
  await row.getByRole('button', { name: 'Save & validate' }).click();
  await expect(row.getByRole('status')).toContainText('ratings are enabled');
  expect(checks).toEqual([{ key: 'candidate-omdb', pageOwned: false }]);
});

test('a profile household shows Owner PIN management instead of the legacy maturity ceiling', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profiles`);

  await expect(
    page.getByText(
      'Rename, delete, and Adult profile creation are not available yet. They will be managed here in Den on the web.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Owner PIN Set/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Parental controls/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Owner PIN Set/ }).click();
  const ownerPin = page.getByRole('region', { name: 'Owner PIN' });
  await expect(page.getByRole('heading', { name: 'Maturity ceiling' })).toHaveCount(0);
  await expect(page.getByText('Enter your current Owner PIN to change it.')).toBeVisible();
  await ownerPin.getByRole('textbox', { name: 'Owner PIN' }).fill('0000');
  await expect(ownerPin.getByRole('alert')).toHaveText('Wrong PIN.');
  await expect(ownerPin.getByRole('textbox', { name: 'Owner PIN' })).toBeFocused();
  await ownerPin.getByRole('textbox', { name: 'Owner PIN' }).fill('1234');
  await expect(page.getByRole('button', { name: 'Remove PIN' })).toHaveCount(0);
});

test('a resolved Owner-only profile household may remove its PIN', async ({ page }) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profiles-owner-only`);
  await page.getByRole('button', { name: /Owner PIN Set/ }).click();
  const ownerPin = page.getByRole('region', { name: 'Owner PIN' });
  await ownerPin.getByLabel('Owner PIN', { exact: true }).fill('1234');
  await ownerPin.getByRole('button', { name: 'Remove PIN' }).click();
  await ownerPin.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => page.evaluate(() => window.fixtureOwnerPin.value())).toBe(null);
});

test('an Owner PIN change refuses a newer row, restores current-PIN focus and retries exactly', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profiles`);
  await page.getByRole('button', { name: /Owner PIN Set/ }).click();
  const ownerPin = page.getByRole('region', { name: 'Owner PIN' });

  await ownerPin.getByLabel('Owner PIN', { exact: true }).fill('1234');
  await expect(ownerPin.getByLabel('New Owner PIN')).toBeVisible();
  await page.evaluate(() => window.fixtureOwnerPin.replace('5678'));
  // PinInput submits as soon as the fourth digit is entered.
  await ownerPin.getByLabel('New Owner PIN').fill('4321');

  await expect(ownerPin.getByRole('alert')).toHaveText('Wrong PIN.');
  await expect(ownerPin.getByLabel('Owner PIN', { exact: true })).toBeFocused();
  await ownerPin.getByLabel('Owner PIN', { exact: true }).fill('5678');
  await expect(ownerPin.getByLabel('New Owner PIN')).toHaveValue('4321');
  await ownerPin.getByRole('button', { name: 'Change PIN' }).click();
  await expect.poll(() => page.evaluate(() => window.fixtureOwnerPin.verify('4321'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.fixtureOwnerPin.verify('5678'))).toBe(false);
});

test('an Owner PIN lost reply keeps the candidate and retries the same operation idempotently', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profiles&lose-pin-reply`);
  await page.getByRole('button', { name: /Owner PIN Set/ }).click();
  const ownerPin = page.getByRole('region', { name: 'Owner PIN' });
  await ownerPin.getByRole('textbox', { name: 'Owner PIN' }).fill('1234');
  await ownerPin.getByLabel('New Owner PIN').fill('4321');

  await expect(ownerPin.getByRole('alert')).toHaveText(
    'Couldn’t save that. Check your connection and try again.',
  );
  await expect(ownerPin.getByLabel('New Owner PIN')).toHaveValue('4321');
  await ownerPin.getByRole('button', { name: 'Try again' }).click();
  await expect(ownerPin.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fixtureOwnerPin.verify('4321'))).toBe(true);
  expect(await page.evaluate(() => window.fixtureSettingsAuthority.pinOperationIds())).toEqual(
    expect.arrayContaining([expect.any(String), expect.any(String)]),
  );
  const operationIds = await page.evaluate(() => window.fixtureSettingsAuthority.pinOperationIds());
  expect(new Set(operationIds).size).toBe(1);
});

test('a held old Owner PIN reply cannot unlock or publish into a replacement household', async ({
  page,
}) => {
  await page.goto(
    `${E2E_ORIGIN}/test/settings.html?profiles&pin-authority-replacement&hold-pin-reply`,
  );
  await page.getByRole('button', { name: /Owner PIN Set/ }).click();
  let ownerPin = page.getByRole('region', { name: 'Owner PIN' });
  await ownerPin.getByRole('textbox', { name: 'Owner PIN' }).fill('1234');
  await ownerPin.getByLabel('New Owner PIN').fill('4321');
  await expect
    .poll(() => page.evaluate(() => window.fixtureSettingsAuthority.pinOperationIds().length))
    .toBe(1);

  await page.evaluate(() => window.fixtureSettingsAuthority.replace());
  await page.evaluate(() => window.fixtureSettingsAuthority.releasePinReply());
  ownerPin = page.getByRole('region', { name: 'Owner PIN' });
  await expect(ownerPin.getByRole('textbox', { name: 'Owner PIN' })).toBeVisible();
  await expect(ownerPin.getByLabel('New Owner PIN')).toHaveCount(0);
  await expect(ownerPin.getByRole('alert')).toHaveCount(0);
  await ownerPin.getByRole('textbox', { name: 'Owner PIN' }).fill('5678');
  await expect(ownerPin.getByLabel('New Owner PIN')).toBeVisible();
});

test('a profile household uses the Owner-PIN compound reset and never exposes legacy reset', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profiles`);
  const devices = page.getByRole('region', { name: 'Linked devices' });
  await page.getByRole('button', { name: /Linked devices/ }).click();
  await expect(devices.getByRole('button', { name: 'Reset library key…' })).toHaveCount(0);

  const trigger = devices.getByRole('button', { name: 'Reset library keys…' });
  await trigger.click();
  const pin = devices.getByRole('textbox', { name: 'Owner PIN' });
  await expect(pin).toBeFocused();
  await devices.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await pin.fill('0000');
  await devices.getByRole('button', { name: 'Reset keys' }).click();
  await expect(devices.getByRole('alert')).toContainText('That Owner PIN didn’t match.');
  await expect(pin).toBeFocused();

  await pin.fill('1234');
  await devices.getByRole('button', { name: 'Reset keys' }).click();
  await expect(devices.getByRole('button', { name: 'Reset library keys…' })).toBeFocused();
  expect(await page.evaluate(() => window.fixtureProfileResetPins?.())).toEqual(['0000', '1234']);
});

test('wire 5 without a readable profile directory stays recovery-blocked and never offers either reset', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?wire5-missing`);
  const devices = page.getByRole('region', { name: 'Linked devices' });
  await page.getByRole('button', { name: /Linked devices/ }).click();
  await expect(devices.getByRole('button', { name: /Reset library key/ })).toHaveCount(0);
  await expect(
    devices.getByText(/couldn’t verify this household’s profile directory/),
  ).toBeVisible();
  await expect(devices.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(await page.evaluate(() => window.fixtureProfileResetPins?.())).toEqual([]);
});

test('an interrupted compound reset remains visible and actionable without asking for a new PIN', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profile-reset-pending`);
  await page.getByRole('button', { name: /Linked devices/ }).click();
  const devices = page.getByRole('region', { name: 'Linked devices' });
  await expect(devices.getByText('Library key reset in progress.')).toBeVisible();
  await devices.getByRole('button', { name: 'Continue key reset' }).click();
  expect(await page.evaluate(() => window.fixtureProfileResetPins?.())).toEqual(['']);
  await expect(devices.getByRole('button', { name: 'Reset library keys…' })).toBeFocused();
});

test('an ambiguous compound start focuses its durable Continue recovery action', async ({
  page,
}) => {
  await page.goto(`${E2E_ORIGIN}/test/settings.html?profiles&profile-reset-waiting`);
  await page.getByRole('button', { name: /Linked devices/ }).click();
  const devices = page.getByRole('region', { name: 'Linked devices' });
  await devices.getByRole('button', { name: 'Reset library keys…' }).click();
  await devices.getByRole('textbox', { name: 'Owner PIN' }).fill('1234');
  await devices.getByRole('button', { name: 'Reset keys' }).click();
  await expect(devices.getByRole('button', { name: 'Continue key reset' })).toBeFocused();
  await expect(devices.getByRole('alert')).toContainText('still in progress');
});

test('opening Settings preserves legacy installs without automatic config exchange', async ({
  page,
}) => {
  await guardNetwork(page);
  await page.route('**/routes', (route) =>
    route.fulfill({
      json: {
        addons: {
          den: [{ url: 'https://den.example/den' }],
          scout: [{ url: 'https://den.example/scout' }],
        },
      },
    }),
  );
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('**/lib/*/grants', (route) => route.fulfill({ json: { grants: [] } }));
  await routeTmdb(page, (route) => route.fulfill({ json: { results: [], images: {} } }));
  // Even a reachable old install must not cause a Settings visit to mutate the plugin list.
  await page.route('**/scout/OLD/manifest.json', (route) =>
    route.fulfill({
      json: {
        id: 'com.den.scout',
        resources: ['stream'],
        name: 'Old Scout',
        version: '1',
      },
    }),
  );
  const exchanges = [];
  await page.route('**/den/migrate', (route) => {
    exchanges.push(route.request().method());
    return route.fulfill({ json: { manifestUrl: '/den/NEW/manifest.json' } });
  });
  await page.goto(`${E2E_ORIGIN}/test/settings.html?legacy-addon`);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Plugins/ }).click();
  await expect(page.getByRole('region', { name: 'Plugins' })).toContainText('den.example');
  const stored = await page.evaluate(() =>
    window.fixtureRows().find((row) => row.name === 'plugins'),
  );
  expect(Object.keys(stored.values)).toEqual(['https://den.example/scout/OLD/manifest.json']);
  expect(exchanges).toEqual([]);
});
