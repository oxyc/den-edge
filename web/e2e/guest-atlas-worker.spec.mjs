// A guest's Atlas, asked by the library Worker. The content calls run in the Worker, whose relayFetch is a module of
// its own: unless the page hands it the grants it holds, every `/atlas/~<gid>/…` it makes goes out without
// `x-den-grant`, den-edge answers each with its one 404, and the guest silently gets TMDB in Atlas's place. The page's
// own manifest read carried the grant all along, which is all a manifest-only mock ever saw.
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { GID, newEdge, routeGuestEdge } from './guest-edge.mjs';

const SECRET = 'guest-atlas-secret';
const GRANT = {
  gid: GID,
  name: 'Oskar',
  secret: SECRET,
  addons: { atlas: `/atlas/~${GID}`, den: `/den/~${GID}` },
  overrides: [],
  expiresAt: null,
  ended: false,
};
/** The one title the shared Atlas recommends: TMDB's own lists are empty here, so only Atlas can put it on Home. */
const PICK = 4242;

/**
 * A guest browser with the grant held, the real app and its real library Worker, and a shared Atlas that answers only
 * calls carrying the grant — as den-edge does. `answer` decides what an authenticated Worker-made call gets.
 */
async function guestWithSharedAtlas(page, answer) {
  await page.addInitScript((grant) => {
    localStorage.setItem('den.grants', JSON.stringify([grant]));
    // Marks the page's own requests, so a request without it was made by the Worker.
    const pageFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}));
      headers.set('x-den-test-fetch-realm', 'page');
      return pageFetch(input, { ...init, headers });
    };
  }, GRANT);
  await routeGuestEdge(page, newEdge());
  await page.route(`${E2E_ORIGIN}/grant/addons`, (route) =>
    route.request().headers()['x-den-grant'] === `${GID}:${SECRET}`
      ? route.fulfill({
          json: {
            gid: GID,
            name: GRANT.name,
            addons: GRANT.addons,
            overrides: [],
            expiresAt: null,
          },
        })
      : route.fulfill({ status: 404, json: { error: 'not_found' } }),
  );
  const asked = [];
  await page.route(`${E2E_ORIGIN}/atlas/~${GID}/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rest = url.pathname.slice(`/atlas/~${GID}`.length);
    const headers = request.headers();
    const call = {
      rest,
      worker: headers['x-den-test-fetch-realm'] === undefined,
      grant: headers['x-den-grant'] ?? null,
      member: headers['x-den-library-member'] ?? null,
    };
    asked.push(call);
    if (call.grant !== `${GID}:${SECRET}`)
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    if (rest === '/manifest.json')
      return route.fulfill({ json: { id: 'com.den.atlas', name: 'Atlas', catalogs: [] } });
    return answer(route, call);
  });
  return asked;
}

const atlasHome = (route, { rest }) => {
  if (/^\/recommend\/(?:home|movies|series)\.json$/.test(rest))
    return route.fulfill({ json: { slides: [{ type: 'movie', id: PICK }] } });
  if (rest === '/recommend')
    return route.fulfill({ json: { slides: [{ type: 'movie', id: PICK }] } });
  if (/^\/index\/row\/(?:movie|series)\.json$/.test(rest))
    return route.fulfill({
      json: { titles: [{ type: 'movie', id: PICK, title: `Movie ${PICK}` }] },
    });
  return route.fulfill({ status: 404, json: { error: 'not_found' } });
};

async function openHome(page) {
  // A guest with no library of their own looks around, as a visitor does, with the host's shared addons.
  await page.goto(`${E2E_ORIGIN}/`);
  await page.getByRole('button', { name: 'Look around instead' }).click();
}

test('the library Worker asks the guest’s shared Atlas with the grant, and Home shows what Atlas picked', async ({
  page,
}) => {
  const asked = await guestWithSharedAtlas(page, atlasHome);
  await openHome(page);

  // Atlas's pick is the Den billboard, not a TMDB fallback (TMDB's lists are empty here).
  await expect(page.locator('.billboard')).toContainText(`Movie ${PICK}`, { timeout: 30_000 });

  for (const route of [/^\/recommend\/home\.json$/, /^\/index\/row\/movie\.json$/])
    await expect
      .poll(() => asked.some((call) => call.worker && route.test(call.rest)), {
        message: `the Worker asked ${route}`,
        timeout: 30_000,
      })
      .toBe(true);
  for (const call of asked.filter((call) => call.worker)) {
    expect(call.grant, `${call.rest} left the Worker without the grant`).toBe(`${GID}:${SECRET}`);
    expect(call.member, `${call.rest} claimed membership`).toBeNull();
  }
});

test('a grant den-edge says expired, met by the Worker, ends the grant on the page', async ({
  page,
}) => {
  const asked = await guestWithSharedAtlas(page, (route, call) =>
    call.worker
      ? route.fulfill({ status: 410, json: { error: 'grant_expired', expiredAt: 1 } })
      : atlasHome(route, call),
  );
  await openHome(page);
  await expect
    .poll(() => asked.some((call) => call.worker && call.grant === `${GID}:${SECRET}`), {
      timeout: 30_000,
    })
    .toBe(true);
  // Only the Worker was told the grant ended; the page learns it from the Worker, and says so.
  expect(asked.filter((call) => !call.worker).every((call) => call.rest === '/manifest.json')).toBe(
    true,
  );
  await expect
    .poll(
      () => page.evaluate(() => JSON.parse(localStorage.getItem('den.grants') ?? '[]')[0]?.ended),
      { timeout: 30_000 },
    )
    .toBe(true);
});
