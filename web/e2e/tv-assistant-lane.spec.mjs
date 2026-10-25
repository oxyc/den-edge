// An LG or Samsung TV with an assistant connected drains its own lane of the assistant's TV queue (den-spec
// assistant-v1 §16 *TV lanes*): the lane its household play key derives, named in the drain's body, opened as the TV
// queue's and acknowledged on that lane. It leaves the projection to other devices, which publish the same one.
// Applying an accepted play is covered with den-core's sealed vectors in libraryAssistantAuthority.test.ts; here the
// lane holds a request sealed for another library, which the TV refuses and acknowledges.
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const ID = '0123456789abcdef0123456789abcdef';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const FOREIGN = JSON.parse(
  readFileSync(new URL('../../spec/vectors/assistant-v1.json', import.meta.url), 'utf8'),
).fixed.request.sealed;

/** The lane a play key derives (assistant-v1 §16). */
const laneOf = (playKey) =>
  Buffer.from(
    hkdfSync('sha256', Buffer.from(playKey, 'base64url'), 'den/link/v1', 'assistant-tv', 16),
  ).toString('hex');

/** den-edge's consent and assistant routes, recording what reached them; `lane` holds one foreign request. */
async function routeAssistant(page) {
  const seen = { drains: [], acks: [], projections: 0 };
  const lanes = new Map();
  await page.route('https://claude.ai/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Claude</title>' }),
  );
  await page.route(`${E2E_ORIGIN}/oauth/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/oauth/request/${ID}`)
      return route.fulfill({
        json: {
          client: 'Claude',
          redirectHost: 'claude.ai',
          verified: true,
          write: true,
          read: true,
        },
      });
    if (path === `/oauth/request/${ID}/approve`)
      return route.fulfill({ json: { redirect: `${CALLBACK}?code=abc&state=s` } });
    if (path === '/oauth/connections') return route.fulfill({ json: { connections: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route(`${E2E_ORIGIN}/assistant/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const queue = url.searchParams.get('queue');
    const tv = url.searchParams.get('tv');
    if (url.pathname === '/assistant/dropbox') return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/assistant/projection/')) {
      seen.projections += 1;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/assistant/drain') {
      seen.drains.push({ queue, tv, body: request.postData() ? request.postDataJSON() : null });
      if (queue === 'tv' && tv && !lanes.has(tv)) lanes.set(tv, [{ seq: 1, sealed: FOREIGN }]);
      const messages = (queue === 'tv' && lanes.get(tv)) || [];
      if (queue === 'tv') lanes.set(tv, []);
      return route.fulfill({ json: { messages } });
    }
    if (url.pathname === '/assistant/ack') {
      seen.acks.push({ queue, tv, ...request.postDataJSON() });
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return seen;
}

test('a TV with an assistant drains its own lane, named, refuses a foreign request there, and publishes nothing', async ({
  page: tv,
}) => {
  const edge = newEdge();
  await routeGuestEdge(tv, edge);
  const seen = await routeAssistant(tv);
  await tv.goto(E2E_ORIGIN);
  await tv.getByRole('button', { name: 'Look around instead' }).click();
  // Saving a title makes the library the TV then holds through the invite.
  await tv.goto(`${E2E_ORIGIN}/movie/1002`);
  const saved = tv.getByRole('button', { name: 'Watchlist', exact: true });
  await saved.click();
  await expect(saved).not.toHaveAttribute('aria-busy', 'true');
  await tv.goto('about:blank');
  await tv.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await tv
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);

  await tv.goto(`${E2E_ORIGIN}/connect?request=${ID}`);
  const dialog = tv.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
  await dialog.getByRole('checkbox', { name: /Allow changes to my library/ }).check();
  await dialog.getByRole('checkbox', { name: /Allow reading my watchlist and history/ }).check();
  await dialog.getByRole('button', { name: 'Allow' }).click();
  await tv.waitForURL(`${CALLBACK}?code=abc&state=s`);
  await tv.goto(E2E_ORIGIN);

  const storedKey = () =>
    tv.evaluate(() => JSON.parse(localStorage.getItem('den.tvPlayKey.v1') ?? 'null')?.key ?? null);
  await expect.poll(storedKey, { timeout: 30_000 }).not.toBeNull();
  const lane = laneOf(await storedKey());

  // Drained by the lane its play key derives, naming the TV; the foreign request is refused and acknowledged there.
  await expect
    .poll(() => seen.acks, { timeout: 45_000 })
    .toContainEqual({ queue: 'tv', tv: lane, upTo: 1 });
  const laneDrains = seen.drains.filter((d) => d.queue === 'tv');
  expect(laneDrains.length).toBeGreaterThan(0);
  expect(
    laneDrains.every((d) => d.tv === lane && typeof d.body?.name === 'string' && d.body.name),
  ).toBe(true);
  // The library's own queue is drained beside it, and nothing is published from the TV.
  expect(seen.drains.some((d) => d.queue === null)).toBe(true);
  expect(seen.projections).toBe(0);
});
