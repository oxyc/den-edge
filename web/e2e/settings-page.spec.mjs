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
      await page.route('**/routes', (r) => r.fulfill({ json: {} }));
      await page.route('**/version', (r) => r.fulfill({ json: { version: '0.67.0' } }));
      await page.route('**/config', (r) => r.fulfill({ json: { simklClientId: 'client-1' } }));
      await routeTmdb(page, (route) => {
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
      await expect(services.getByRole('checkbox', { name: /Netflix/ })).toBeChecked();
      await expect(services.getByText('(series only)')).toBeVisible();
      await expectViewportWidth();

      // Parental controls stay locked behind the PIN.
      await page.getByRole('button', { name: /Parental controls/ }).click();
      const parental = page.getByRole('region', { name: 'Parental controls' });
      await expect(parental.getByRole('radio', { name: 'R' })).toBeDisabled();
      await parental.getByLabel('Parental PIN').fill('1234');
      await parental.getByRole('button', { name: 'Unlock' }).click();
      await expect(parental.getByRole('radio', { name: 'R' })).toBeEnabled();

      // A delete asks first, in place.
      await page.getByRole('button', { name: /Plugins/ }).click();
      const plugins = page.getByRole('region', { name: 'Plugins' });
      await plugins.getByRole('button', { name: 'Remove' }).click();
      await expect(plugins.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(plugins.getByRole('button', { name: 'Remove' })).toBeVisible();

      await page.getByRole('button', { name: /Linked devices/ }).click();
      const devices = page.getByRole('region', { name: 'Linked devices' });
      await expect(devices.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
      await expect(
        devices.getByRole('heading', { name: 'Devices with your library', exact: true }),
      ).toHaveCount(0);
      await expect(
        devices.getByRole('heading', { name: 'Linked to this browser', exact: true }),
      ).toHaveCount(0);
      await expect(
        devices.getByRole('heading', { name: 'Your library', exact: true }),
      ).toBeVisible();
      await expect(
        devices.getByRole('heading', { name: 'Join another library', exact: true }),
      ).toBeVisible();
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
      await expect(tv).toContainText('Apple TV · seen');
      await expect(tv.getByRole('button', { name: 'Remove Living Room TV' })).toBeVisible();
      // Libraries are named by whether they're the one open here, not after the TV they came through.
      const open = listed.filter({ hasText: 'Open on this browser' });
      await expect(open).toContainText('Your library');
      await expect(open.getByRole('button', { name: 'Sign out on this browser' })).toBeVisible();
      const other = listed.filter({ hasText: 'Another library' });
      await expect(other).toContainText('Saved on this browser · joined through Cabin TV');
      await expect(
        other.getByRole('button', { name: 'Remove the library joined through Cabin TV' }),
      ).toBeVisible();
      const mac = listed.filter({ hasText: 'Mac' });
      await expect(mac).toHaveCount(1);
      await expect(mac).toContainText('Browser · seen');
      await expect(mac.getByRole('button')).toHaveCount(1);
      const phone = listed.filter({ hasText: 'Phone' });
      await expect(phone).toContainText('added');
      await expect(phone.getByRole('button', { name: 'Remove Phone' })).toBeVisible();
      // The page lists itself a second after Settings opens, so this waits for that row. A regular expression, so
      // it's matched with its case.
      const self = listed.filter({ hasText: /This browser · seen/ });
      await expect(self).toHaveCount(1);
      await expect(self.getByRole('button', { name: 'This device' })).toBeDisabled();

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
    } finally {
      await browser.close();
    }
  });
}
