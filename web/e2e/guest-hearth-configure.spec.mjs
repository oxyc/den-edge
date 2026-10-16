// A native form opens Hearth's real same-origin configure document. The grant stays in the HTTPS POST body, and only
// the short-lived HttpOnly cookie reaches the redirected page: no credential URL, blob document, or shell CSP.
import { test, expect } from '@playwright/test';
import { guardNetwork } from './network.mjs';
import { E2E_ORIGIN } from './base-url.mjs';

const GID = 'a1b2c3d4';
const SECRET = 'guest-secret';
const GRANT = {
  gid: GID,
  name: 'Shared access',
  secret: SECRET,
  addons: {
    atlas: `/atlas/~${GID}`,
    den: `/den/~${GID}`,
    scout: `/scout/~${GID}`,
  },
  overrides: [],
  expiresAt: null,
  ended: false,
};

test('guest Configure uses a native new-tab POST and follows the scoped redirect', async ({
  context,
}) => {
  await context.addInitScript(
    (grant) => localStorage.setItem('den.grants', JSON.stringify([grant])),
    GRANT,
  );
  const page = await context.newPage();
  await guardNetwork(page);
  const order = [];

  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) =>
    route.fulfill({ json: { version: 'guest-configure' } }),
  );
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('**/tmdb/3/**', (route) => route.fulfill({ json: { results: [], images: {} } }));
  await page.route('**/grant/addons', (route) =>
    route.fulfill({
      json: {
        gid: GID,
        name: GRANT.name,
        addons: GRANT.addons,
        overrides: [],
        expiresAt: null,
      },
    }),
  );
  await context.route(`**/grant/den-configure`, (route) => {
    order.push('bootstrap');
    expect(route.request().method()).toBe('POST');
    expect(route.request().postData()).toBe(`grant=${GID}%3A${SECRET}`);
    expect(route.request().headers()).not.toHaveProperty('x-den-grant');
    return route.fulfill({
      status: 303,
      headers: {
        'set-cookie': `den_guest_configure=${GID}.${SECRET}; Path=/den/~${GID}; HttpOnly; SameSite=Strict`,
        location: `/den/~${GID}/configure`,
      },
    });
  });
  await context.route(new RegExp(`/den/~${GID}/configure$`), (route) => {
    order.push('configure');
    expect(route.request().headers().cookie).toContain(`den_guest_configure=${GID}.${SECRET}`);
    expect(route.request().headers()).not.toHaveProperty('x-den-grant');
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>Den Hearth setup</h1><p id="ran"></p><script>document.querySelector("#ran").textContent="setup script ran"</script></body></html>',
    });
  });
  await page.route(`**/{atlas,den}/~${GID}/manifest.json`, (route) =>
    route.fulfill({ status: 404, body: 'not available' }),
  );

  await page.goto(`${E2E_ORIGIN}/test/settings.html`);
  await page.getByRole('button', { name: /Plugins/ }).click();
  const plugins = page.getByRole('region', { name: 'Plugins' });
  await expect(plugins).toContainText('Using shared settings');
  const popup = page.waitForEvent('popup');
  await plugins.getByRole('button', { name: 'More actions for Den Hearth' }).click();
  await page.getByRole('menuitem', { name: 'Edit my Hearth settings' }).click();
  const setup = await popup;
  await expect(setup).toHaveURL(`${E2E_ORIGIN}/den/~${GID}/configure`);
  await expect.poll(() => order).toEqual(['bootstrap', 'configure']);
});
