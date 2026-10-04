import { readFileSync } from 'node:fs';
import { guardNetwork } from './network.mjs';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';

// den-edge used to keep the app shell and the build's hashed files in a service worker (`public/sw.js`), which
// could outlive the release it came from and leave a visit stuck half-drawn. That worker is retired: den no
// longer registers one (`main.ts`), and `/sw.js` now only tears down a registration a browser already has.
// `LEGACY` stands in for the kind of worker this repo used to ship — install, claim, one cache entry — so this
// test has something real to clean up, not merely a script that looks harmless on its own.
const LEGACY = `
  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open('den-page-v1').then((cache) => cache.put('/', new Response('old shell'))));
    self.skipWaiting();
  });
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
`;
const RETIRING = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('a browser holding the old service worker ends up with no registration and no caches, and renders fully', async ({
  page,
}) => {
  await guardNetwork(page);
  let current = LEGACY;
  // Context-level, like `guardNetwork`'s own catch-all: a service worker's script fetch is not a page-initiated
  // request, and the two routes are told apart only by which one is registered to match first.
  await page
    .context()
    .route(`${E2E_ORIGIN}/sw.js`, (route) =>
      route.fulfill({ contentType: 'text/javascript', body: current }),
    );

  await page.goto(`${E2E_ORIGIN}/test/router.html`);
  await page.evaluate(() => navigator.serviceWorker.register('/sw.js'));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  expect(await page.evaluate(() => caches.keys())).toEqual(['den-page-v1']);

  // The deploy: `/sw.js` now answers with the retiring script, and the browser's own registration is told to
  // check for one right now rather than waiting for its normal, far slower update schedule.
  current = RETIRING;
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    }),
  ]);

  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration()) === undefined,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  const active = page.locator('[data-route-page][data-active="true"]');
  await active.getByText('Details', { exact: true }).waitFor();
});
