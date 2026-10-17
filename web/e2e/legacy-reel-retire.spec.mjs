// A migrated household whose library still lists its old Reel install. Since sealing went on, Reel answers that
// install's plaintext config with 400 `bad_config`, for good. Settings retires a legacy install only once Hearth
// carries its resource; one that never answers again must be retired too, or every page load asks it and is refused.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { FIXTURE, routeLibraryEdge } from './library-edge.mjs';

const LEGACY = '/reel/plaintextcfg/manifest.json';

test('Settings retires a legacy Reel install whose config Reel refuses, once Hearth carries trailers', async ({
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
  /** Every Reel manifest asked, in order: the legacy install's, and the box's own (`/reel/manifest.json`). */
  const reel = [];
  await page.route(`${E2E_ORIGIN}/reel/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    reel.push(path);
    return path === LEGACY
      ? route.fulfill({ status: 400, json: { error: 'bad_config' } })
      : route.fulfill({ json: { id: 'com.den.reel', version: '1.0.0', resources: ['meta'] } });
  });

  await page.goto(`${FIXTURE}?seed&legacy-reel`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(`${FIXTURE}?view=settings&online`);
  await expect.poll(() => reel.includes(LEGACY), { timeout: 30_000 }).toBe(true);
  // Seeded with Scout, Hearth and the old Reel: Hearth's streams retire Scout, and the refusal retires Reel.
  await expect(
    page.getByRole('button', { name: 'Plugins 1', exact: true }),
    'only Hearth is left',
  ).toBeVisible({ timeout: 30_000 });

  // Reopened, the page looks Reel up among the library's plugins, then falls back to the box's own. The retired
  // install is no longer among them, so it is not asked.
  reel.length = 0;
  await page.goto(`${FIXTURE}?online`);
  await expect.poll(() => reel.includes('/reel/manifest.json'), { timeout: 30_000 }).toBe(true);
  expect(reel).not.toContain(LEGACY);
});
