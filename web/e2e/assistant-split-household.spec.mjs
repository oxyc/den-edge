// Assistants on a household split into profiles (oxyc/den#366), through the real app and the in-memory den-edge of
// `guest-edge.mjs`, which starts a real profile household (household, Owner and a default Kid, each its own log).
// The connection is the household's (profiles-v1 §6.1): consent writes its rows into the household's library and is
// approved as the household's member, so den-mcp queues to and reads from the household. The lists are Owner's
// (§4): the projection carries Owner's watchlist, sealed for the household's library and sent as its member, and the
// household's queue is drained as its member and handed to Owner's library to apply (assistant-v1 §15).
import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { test, expect, chromium } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

const ID = '0123456789abcdef0123456789abcdef';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
/** A request den-mcp sealed for the vectors' library: another library's, so this household's queue refuses it. */
const FOREIGN = JSON.parse(
  readFileSync(new URL('../../spec/vectors/assistant-v1.json', import.meta.url), 'utf8'),
).fixed.request.sealed;

/** The member proof's library id, or null. */
const memberOf = (request) => request.headers()['x-den-library-member']?.split(':')[0] ?? null;

/** den-edge's consent and assistant routes, answering one write-and-read request and recording what reached them. */
async function routeAssistant(page) {
  const seen = { approvals: [], dropbox: [], projections: [], drains: [], acks: [], listings: [] };
  let queued = [{ seq: 1, sealed: FOREIGN }];
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
    if (path === `/oauth/request/${ID}/approve`) {
      seen.approvals.push({ member: memberOf(request), body: request.postDataJSON() });
      return route.fulfill({ json: { redirect: `${CALLBACK}?code=abc&state=s` } });
    }
    if (path === '/oauth/connections') {
      seen.listings.push(memberOf(request));
      return route.fulfill({ json: { connections: [] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route(`${E2E_ORIGIN}/assistant/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const member = memberOf(request);
    if (path === '/assistant/dropbox') {
      seen.dropbox.push(member);
      return route.fulfill({ status: 204 });
    }
    if (path.startsWith('/assistant/projection/') && request.method() === 'PUT') {
      seen.projections.push({ member, grant: path.split('/').at(-1), ...request.postDataJSON() });
      return route.fulfill({ status: 204 });
    }
    if (path === '/assistant/drain') {
      seen.drains.push(member);
      const messages = queued;
      queued = [];
      return route.fulfill({ json: { messages } });
    }
    if (path === '/assistant/ack') {
      seen.acks.push({ member, ...request.postDataJSON() });
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return seen;
}

/** A projection opened as den-mcp opens it (assistant-v1 §15 *Sealing in parts*): the compact form. */
function openProjection(readKey, library, { grant, set, parts }) {
  const key = Buffer.from(readKey, 'base64url');
  const chunks = parts.map((part, index) => {
    const bytes = Buffer.from(part, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(
      Buffer.from(
        ['den/assistant/projection/v1', library, grant, set, index, parts.length].join('\0'),
      ),
    );
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  });
  return JSON.parse(inflateRawSync(Buffer.concat(chunks)).toString('utf8'));
}

test('on a split household an assistant connects to the household and reads and writes for Owner', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const edge = newEdge({ profiles: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await context.newPage();
    await routeGuestEdge(page, edge);
    const seen = await routeAssistant(page);

    // A guest's laptop accepts an invite on a profile host: its own profile household, with Owner active.
    await page.goto(`${E2E_ORIGIN}/`);
    await page.getByRole('button', { name: 'Look around instead' }).click();
    await page.goto(`${E2E_ORIGIN}/movie/1002`);
    await expect(page.getByRole('button', { name: 'Watchlist', exact: true })).toBeVisible();
    await page.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
    await page
      .getByRole('dialog', { name: 'Accept this invite?' })
      .getByRole('button', { name: 'Accept' })
      .click();
    await expect
      .poll(
        () =>
          page.evaluate(() => JSON.parse(localStorage.getItem('den.links') ?? 'null')?.[0]?.guest),
        { timeout: 30_000 },
      )
      .toBe(true);
    const switcher = page.getByRole('button', { name: 'Switch profile, current Owner' });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(3);
    const [household] = [...edge.libraries].find(([, library]) => library.wireMin === 5);

    // Owner puts a title on its watchlist: Owner's library, which the assistant reads.
    await page.goto(`${E2E_ORIGIN}/movie/1003`);
    const watchlist = page.getByRole('button', { name: 'Watchlist', exact: true });
    await watchlist.click();
    await expect(watchlist).toHaveAttribute('aria-pressed', 'true');

    // The member allows the assistant to change and read the library.
    await page.goto(`${E2E_ORIGIN}/connect?request=${ID}`);
    const dialog = page.getByRole('dialog', { name: 'Connect claude.ai to Den?' });
    await dialog.getByRole('checkbox', { name: /Allow changes to my library/ }).check();
    await dialog.getByRole('checkbox', { name: /Allow reading my watchlist and history/ }).check();
    const before = edge.libraryRequests.length;
    await dialog.getByRole('button', { name: 'Allow' }).click();
    await page.waitForURL(`${CALLBACK}?code=abc&state=s`);

    // The connection's rows (drop-box key, grant, play and read records) went to the household's library, and the
    // approval proved the household's membership: the connection is the household's.
    const writes = edge.libraryRequests
      .slice(before)
      .filter(({ action }) => action === 'batch')
      .map(({ id }) => id);
    expect(writes.filter((id) => id === household).length).toBeGreaterThanOrEqual(4);
    expect(seen.approvals).toHaveLength(1);
    const [approval] = seen.approvals;
    expect(approval.member).toBe(household);
    expect(approval.body.write.grant).toMatch(/^[0-9a-f]{32}$/);
    const { grant, readKey } = approval.body.read;
    expect(seen.dropbox.length).toBeGreaterThan(0);
    expect(new Set(seen.dropbox)).toEqual(new Set([household]));

    // Back in Den, the assistant's work runs for the household: the projection is Owner's lists, sealed for the
    // household's library and sent as its member.
    await page.goto(`${E2E_ORIGIN}/`);
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => seen.projections.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const [published] = seen.projections;
    expect(published.member).toBe(household);
    expect(published.grant).toBe(grant);
    const view = openProjection(readKey, household, published);
    expect(view.library).toBe(household);
    expect(view.watchlist.map(([index]) => view.titles[index])).toContainEqual(['movie', 1003]);

    // The household's queue is drained and acknowledged as its member, after Owner's library opened what it held
    // with the household's connection (a request sealed for another library is refused, and acknowledged).
    await expect
      .poll(() => seen.acks, { timeout: 30_000 })
      .toEqual([{ member: household, upTo: 1 }]);
    expect(new Set(seen.drains)).toEqual(new Set([household]));
    // Grants are renewed while den-edge lists the household's connections.
    await expect.poll(() => seen.listings.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(new Set(seen.listings)).toEqual(new Set([household]));
  } finally {
    await browser.close();
  }
});
