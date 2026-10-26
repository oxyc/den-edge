// A TV in the library takes plays from any device holding it (den-spec inbox-v1 §5): it makes a household play key
// when it checks in, drains the queue that key derives, and starts a fresh play as its own Play would. The plays are
// sealed here exactly as a sender seals them, so nothing of the TV's own sending path is involved.
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { CODE, newEdge, routeGuestEdge } from './guest-edge.mjs';

/** A message sealed to the household queue `playKey` derives, as inbox-v1 §1 seals one. */
function seal(playKey, message, sentAt = Date.now()) {
  const key = Buffer.from(playKey, 'base64url');
  const enc = Buffer.from(hkdfSync('sha256', key, 'den/link/v1', 'enc', 32));
  const inbox = Buffer.from(hkdfSync('sha256', key, 'den/link/v1', 'inbox', 24)).toString('hex');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', enc, nonce);
  cipher.setAAD(Buffer.from('den/inbox/v1'));
  const plaintext = JSON.stringify({ id: randomBytes(16).toString('hex'), sentAt, message });
  const sealed = Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
  return { inbox, sealed };
}

/** den-edge's `/inbox/drain`, in memory: each named queue is handed over and emptied. `drains` gets each request's keys. */
async function routeInbox(page, queues, drains) {
  await page.route(`${E2E_ORIGIN}/inbox/drain**`, async (route) => {
    const { keys = [] } = JSON.parse(route.request().postData() ?? '{}');
    drains.push(keys);
    await route.fulfill({
      json: {
        queues: keys.map((key) => {
          const queue = queues.get(key) ?? [];
          queues.delete(key);
          return queue;
        }),
      },
    });
  });
}

test('a TV in the library starts a fresh play sent to its household queue, and not an old one', async ({
  browser,
  page: host,
}) => {
  const edge = newEdge();
  await routeGuestEdge(host, edge);
  await host.goto(E2E_ORIGIN);
  await host.getByRole('button', { name: 'Look around instead' }).click();
  // Saving a title makes the library this host then shares through the invite.
  await host.goto(`${E2E_ORIGIN}/movie/1002`);
  const saved = host.getByRole('button', { name: 'Watchlist', exact: true });
  await saved.click();
  await expect(saved).not.toHaveAttribute('aria-busy', 'true');
  await host.goto(`${E2E_ORIGIN}/#invite=${CODE}`);
  await host
    .getByRole('dialog', { name: 'Accept this invite?' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click();
  await expect.poll(() => edge.libraries.size, { timeout: 30_000 }).toBe(1);
  await host.goto(`${E2E_ORIGIN}/settings`);
  await host.getByRole('button', { name: /Linked devices/ }).click();
  const devices = host.getByRole('region', { name: 'Linked devices' });
  await devices.getByRole('button', { name: 'Get a code' }).click();
  const code = await devices.locator('.code').textContent();

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    const tv = await context.newPage();
    const queues = new Map();
    const drains = [];
    await routeGuestEdge(tv, edge);
    await routeInbox(tv, queues, drains);
    // A playback service, so a play can start once the TV has a source plugin.
    await tv.route('**/routes', (route) =>
      route.fulfill({ json: { remux: [{ url: `${E2E_ORIGIN}/remux` }] } }),
    );
    await tv.route('**/remux/health', (route) => route.fulfill({ json: { status: 'ok' } }));
    await tv.route('**/scout/fixture-install/manifest.json', (route) =>
      route.fulfill({
        json: {
          id: 'com.den.scout',
          name: 'Fixture Scout',
          version: '1.0.0',
          resources: ['stream'],
        },
      }),
    );
    await tv.goto(E2E_ORIGIN);
    await tv.getByLabel('Link code, twelve characters').fill(code);
    await tv.getByLabel('This device’s name').fill('Living room LG');
    await tv.getByRole('button', { name: 'Link', exact: true }).click();
    await devices.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(tv.getByRole('heading', { name: 'Open your Den library' })).toBeHidden();

    // The TV makes its play key when it checks in with the library.
    const storedKey = () =>
      tv.evaluate(
        () => JSON.parse(localStorage.getItem('den.tvPlayKey.v1') ?? 'null')?.key ?? null,
      );
    await expect.poll(storedKey, { timeout: 30_000 }).not.toBeNull();
    const playKey = await storedKey();

    const play = (id, sentAt) =>
      seal(playKey, { type: 'play', tmdbId: id, mediaType: 'movie', title: `Movie ${id}` }, sentAt);
    const old = play(1003, Date.now() - 10 * 60_000);
    const fresh = play(1002);
    const notAPlay = seal(playKey, {
      type: 'addon',
      manifestUrl: 'https://addon.example/manifest.json',
    });
    queues.set(fresh.inbox, [
      { sealed: old.sealed },
      { sealed: notAPlay.sealed },
      { sealed: fresh.sealed },
    ]);

    // With no source plugin yet the play is taken and the TV says why it cannot start it, rather than leaving it
    // to go stale in the queue.
    await expect(tv.getByText('No playable source for “Movie 1002”')).toBeVisible({
      timeout: 30_000,
    });
    expect(queues.has(fresh.inbox)).toBe(false);
    await expect(tv).not.toHaveURL(/\/movie\/1003/);
    // Playback authority belongs to the household queue alone. A legacy pairing credential may still be retained
    // for migration, but it is neither asked for nor allowed to carry playback commands.
    const linkInbox = await tv.evaluate(
      () => JSON.parse(localStorage.getItem('den.links') ?? '[]')[0]?.inboxKey,
    );
    expect(linkInbox).toBeTruthy();
    expect(drains).toContainEqual([fresh.inbox]);
    expect(drains.flat().every((key) => key === fresh.inbox)).toBe(true);

    await tv.goto(`${E2E_ORIGIN}/settings`);
    await tv.getByRole('button', { name: 'Plugins', exact: true }).click();
    await tv
      .getByRole('region', { name: 'Plugins' })
      .getByRole('textbox', { name: 'Plugin manifest URL' })
      .fill(`${E2E_ORIGIN}/scout/fixture-install/manifest.json`);
    await tv.getByRole('button', { name: 'Add plugin' }).click();
    await expect(
      tv.getByRole('button', { name: `More actions for ${new URL(E2E_ORIGIN).host}` }),
    ).toBeVisible({ timeout: 30_000 });
    await tv.goto(E2E_ORIGIN);

    queues.set(fresh.inbox, [{ sealed: play(1002).sealed }]);
    await expect(tv).toHaveURL(/\/movie\/1002[^?]*\?play=1/, { timeout: 30_000 });
  } finally {
    await context.close();
  }
});
