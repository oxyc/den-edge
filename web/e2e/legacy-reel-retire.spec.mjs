// Retiring the automatic config exchange must also stop Settings from deleting old stored plugins.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { FIXTURE, routeLibraryEdge } from './library-edge.mjs';

const LEGACY = '/reel/plaintextcfg/manifest.json';

test('Settings preserves legacy installs after automatic config exchange retirement', async ({
  page,
}) => {
  await routeLibraryEdge(page);
  await page.route('**/routes', (route) =>
    route.fulfill({
      json: {
        addons: { den: [{ url: `${E2E_ORIGIN}/den` }], reel: [{ url: `${E2E_ORIGIN}/reel` }] },
      },
    }),
  );
  await page.route(`${E2E_ORIGIN}/den/hearthcfg789/**`, (route) =>
    new URL(route.request().url()).pathname.endsWith('/manifest.json')
      ? route.fulfill({
          json: { id: 'com.den.hearth', version: '1.0.0', resources: ['stream', 'meta'] },
        })
      : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  /** Every Reel address asked, in order: the legacy install's manifest, and the box's own (`/reel/health`). */
  const reel = [];
  await page.route(`${E2E_ORIGIN}/reel/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    reel.push(path);
    if (path === LEGACY) return route.fulfill({ status: 400, json: { error: 'bad_config' } });
    if (path === '/reel/health') return route.fulfill({ json: { status: 'ok' } });
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });

  await page.goto(`${FIXTURE}?seed&online&legacy-reel`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(`${FIXTURE}?view=settings&online`);
  await expect.poll(() => reel.includes(LEGACY), { timeout: 30_000 }).toBe(true);
  // Even with a healthy combined Hearth and a permanently refused legacy config, a Settings visit does not
  // remove any of the three stored plugins. Removal remains an explicit viewer action.
  await expect(page.getByRole('button', { name: 'Plugins 3', exact: true })).toBeVisible();

  // The persisted library is unchanged when Settings opens in a fresh page lifecycle.
  reel.length = 0;
  await page.goto(`${FIXTURE}?view=settings&online`);
  await expect.poll(() => reel.includes(LEGACY), { timeout: 30_000 }).toBe(true);
  await expect(page.getByRole('button', { name: 'Plugins 3', exact: true })).toBeVisible();
});
