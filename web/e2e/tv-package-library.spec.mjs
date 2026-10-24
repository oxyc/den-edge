import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const API = 'https://den-tv-api.example.invalid';
const ENTRY = `${E2E_ORIGIN}/package/index.html`;

async function packaged(page, edge) {
  await page.addInitScript(() => {
    globalThis.__tvPolicyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__tvPolicyViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  // Same relay implementation as hosted pairing, now behind an explicit cross-origin boundary.
  // Do not disable browser web security to make packaged requests pass.
  const fixturePage = {
    context: () => page.context(),
    route: (pattern, handler) =>
      page.route(pattern, (route) =>
        handler(
          new Proxy(route, {
            get(target, name) {
              if (name === 'fulfill')
                return (options) =>
                  target.fulfill({
                    ...options,
                    headers: {
                      'access-control-allow-origin': E2E_ORIGIN,
                      'access-control-expose-headers': 'x-den-generation,x-den-wire-min',
                      ...options.headers,
                    },
                  });
              const value = Reflect.get(target, name);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      ),
  };
  await routeGuestEdge(fixturePage, edge, API);
  await page.route(`${E2E_ORIGIN}/package/**`, (route) => route.continue());
}

test('bundled app routes, encrypted Worker sync and pairing work without a SPA server or same-origin API', async ({
  page: host,
  browser,
}) => {
  const edge = newEdge();
  const localFailures = [];
  const leakedCredentials = [];
  const observeCredentials = (page) =>
    page.on('request', (request) => {
      const headers = request.headers();
      if (
        new URL(request.url()).origin !== API &&
        Object.keys(headers).some((name) => /^x-den-(?:library|grant|link)/.test(name))
      )
        leakedCredentials.push(request.url());
    });
  observeCredentials(host);
  host.on('response', (response) => {
    if (response.url().startsWith(E2E_ORIGIN) && response.status() >= 400)
      localFailures.push(response.url());
  });
  await packaged(host, edge);
  await host.goto(`${ENTRY}#/movie/1002`);
  if (process.env.DEN_TV_OLD_ENGINE_LIMITS === '1') {
    expect(await host.evaluate(() => globalThis.__denOldEngineLimits)).toEqual({
      proxy: 'undefined',
      bigint: 'undefined',
      wasm: 'undefined',
    });
  }
  expect(await host.evaluate(() => globalThis.__tvSdkBridgeOrder)).toBe('before-app');
  await host.getByRole('button', { name: 'Look around instead' }).click();
  const saved = host.getByRole('button', { name: 'Watchlist', exact: true });
  await saved.click();
  await expect(saved).toHaveAttribute('aria-pressed', 'true');
  // The pressed state is optimistic. Keep this page alive until its durable write finishes, or the hard
  // navigation below can cancel the write before the linked package has anything to sync.
  await expect(saved).not.toHaveAttribute('data-saving', 'true');
  // An invite is consumed on application startup, not by an in-document fragment change.
  await host.goto('about:blank');
  await host.goto(`${ENTRY}#invite=${CODE}`);
  await host
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
  // The relay sees the upload before the page commits the new library and resets to Home; leave it alone until then.
  await expect
    .poll(() => host.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? '[]').length))
    .toBe(1);
  await host.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(host).toHaveURL(`${ENTRY}#/settings`);
  await host.getByRole('button', { name: /Linked devices/ }).click();
  const devices = host.getByRole('region', { name: 'Linked devices' });
  await devices.getByRole('button', { name: 'Get a code' }).click();
  const code = await devices.locator('.code').textContent();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const tv = await context.newPage();
    observeCredentials(tv);
    await packaged(tv, edge);
    await tv.goto(ENTRY);
    await tv.getByLabel('Link code, twelve characters').fill(code);
    await tv.getByLabel('This device’s name').fill('Samsung package');
    await tv.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(devices.getByText('Allow “Samsung package”?')).toBeVisible();
    await devices.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(tv.getByRole('heading', { name: 'Open your Den library' })).toBeHidden();
    await tv.getByRole('link', { name: 'Watchlist', exact: true }).click();
    await expect(tv).toHaveURL(`${ENTRY}#/watchlist`);
    await expect(tv.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible();
    await tv.reload();
    await expect(tv.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible();
    await tv
      .getByRole('link', { name: /Movie 1002/ })
      .last()
      .click();
    await expect(tv).toHaveURL(/index\.html#\/movie\/1002/);
    await tv.keyboard.press('Escape');
    await expect(tv).toHaveURL(`${ENTRY}#/watchlist`);
    await tv.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(tv).toHaveURL(`${ENTRY}#/`);
    await expect(tv.getByRole('region', { name: 'Watchlist', exact: true })).toBeVisible();
    expect(edge.refusedStarts).toBe(0);
    expect(edge.libraryRequests.length).toBeGreaterThan(0);
    expect(localFailures).toEqual([]);
    expect(leakedCredentials).toEqual([]);
    expect(await host.evaluate(() => globalThis.__tvPolicyViolations)).toEqual([]);
    expect(await tv.evaluate(() => globalThis.__tvPolicyViolations)).toEqual([]);
  } finally {
    await context.close();
  }
});
