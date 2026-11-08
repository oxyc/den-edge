import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';
import { sourceRefreshFixture } from './source-refresh-fixture.mjs';

const API = 'https://den-tv-api.example.invalid';
const ENTRY = `${E2E_ORIGIN}/package/index.html`;

async function packaged(page, edge, sourceFailures) {
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
  if (sourceFailures)
    await page.route('**/diagnostics/failure', async (route) => {
      if (route.request().method() === 'POST') sourceFailures.push(route.request().postDataJSON());
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': E2E_ORIGIN,
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    });
  await page.route(`${E2E_ORIGIN}/package/**`, (route) => route.continue());
}

test('bundled app routes, encrypted Worker sync and pairing work without a SPA server or same-origin API', async ({
  page: host,
  browser,
}) => {
  const edge = newEdge();
  const localFailures = [];
  const leakedCredentials = [];
  const sourceFailures = [];
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
  await packaged(host, edge, sourceFailures);
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
  await host.goto(`${ENTRY}#/movie/1003`);
  const seen = host.getByRole('button', { name: 'Seen', exact: true });
  await seen.click();
  await expect(seen).toHaveAttribute('aria-pressed', 'true');
  await expect(seen).not.toHaveAttribute('data-saving', 'true');
  // An invite is consumed on application startup, not by an in-document fragment change.
  await host.goto('about:blank');
  await host.goto(`${ENTRY}#invite=${CODE}`);
  await host
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
  // The relay sees the upload before the page commits the new library and redraws in it; leave it alone until then.
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
    await packaged(tv, edge, sourceFailures);
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
    await expect(
      tv.getByRole('region', { name: 'Watched', exact: true }).getByText('Movie 1003'),
    ).toBeVisible();
    await tv.reload();
    await expect(tv.getByRole('link', { name: /Movie 1002/ }).first()).toBeVisible();
    await expect(
      tv.getByRole('region', { name: 'Watched', exact: true }).getByText('Movie 1003'),
    ).toBeVisible();
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
    await expect.poll(() => sourceFailures.length).toBeGreaterThan(0);
    for (const report of sourceFailures) {
      expect(report).toMatchObject({
        operation: 'source_lookup',
        kind: 'transport',
        outcome: 'terminal',
        route: 'content_service',
        durationBucket: 'fast',
        priorList: false,
        attempt: 0,
      });
      const expectedKeys = [
        'attempt',
        'correlation',
        'durationBucket',
        'generation',
        'kind',
        'operation',
        'outcome',
        'platform',
        'priorList',
        'route',
      ];
      if ('release' in report) expectedKeys.push('release');
      expect(Object.keys(report).sort()).toEqual(expectedKeys.sort());
      expect(JSON.stringify(report)).not.toMatch(/Movie 100[23]|Samsung package|den\.links/i);
    }
    expect(await host.evaluate(() => globalThis.__tvPolicyViolations)).toEqual([]);
    expect(await tv.evaluate(() => globalThis.__tvPolicyViolations)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('packaged title refresh keeps the prior list when limited and warms only after admission', async ({
  page,
}) => {
  const requests = await sourceRefreshFixture(page, { packaged: true });
  await page.goto(`${E2E_ORIGIN}/package/test/detail-parity.html#/movie/42`);
  const active = page.locator('[data-active="true"]');
  const sources = active
    .locator('header.hero')
    .getByRole('button', { name: 'Sources', exact: true });
  await sources.focus();
  await page.keyboard.press('Enter');
  const panel = active.locator('.source-panel');
  await expect(panel.getByText('Prior.Movie.1080p.mkv')).toBeVisible();
  const late = panel.getByRole('status').filter({
    hasText: 'Sources still answering when this early list arrived: 1. It may be short.',
  });
  await expect(late).toBeVisible();
  await expect(active.getByRole('button', { name: 'Sources, 1 available' })).toBeFocused();
  const plainBefore = requests.plain;
  const refresh = panel.getByRole('button', { name: 'Check for sources again', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(
    panel.getByRole('status').filter({ hasText: 'Sources were checked recently' }),
  ).toBeVisible();
  await expect(panel.getByText('Prior.Movie.1080p.mkv')).toBeVisible();
  await expect(late).toBeVisible();
  expect(requests).toMatchObject({ fresh: 1, plain: plainBefore });
  const retry = panel.getByRole('button', { name: 'Try again', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText('Rebuilt.Movie.1080p.mkv')).toBeVisible();
  await expect(late).toHaveCount(0);
  await expect.poll(() => requests.plain).toBe(plainBefore + 1);
  expect(requests.fresh).toBe(2);
});
