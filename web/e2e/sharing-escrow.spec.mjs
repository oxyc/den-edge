// Settings › Sharing keeps every live invite's escrow on what the household now shares (combined Hearth and Atlas),
// through the production Worker and an in-memory den-edge: opening it writes each stale invite once, and an invite
// already holding those addons is left alone, however many times the page's inputs settle.
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

const FIXTURE = `${E2E_ORIGIN}/test/worker-hydration.html`;
const ADDONS = ['den', 'scout', 'atlas', 'reel', 'subtitles'];

/** den-edge's `escrow` of a grant: SHA-256 of `[[addon, install], …]` in `ADDONS` order (`grants.rs`). */
const escrowOf = (addons, installs) =>
  createHash('sha256')
    .update(
      JSON.stringify(ADDONS.filter((a) => addons.includes(a)).map((a) => [a, installs[a] ?? ''])),
    )
    .digest('hex');

const grant = (gid, name, installs) => ({
  gid,
  name,
  status: 'active',
  addons: Object.keys(installs),
  escrow: escrowOf(Object.keys(installs), installs),
  createdAt: 1_800_000_000_000,
  codeExpiresAt: 1_900_000_000_000,
  accessDays: null,
  accessUntil: null,
  redeemedAt: 1_800_000_100_000,
  expiresAt: null,
  devices: 1,
  deviceCount: 1,
  lastUsedAt: null,
  playsTotal: 0,
  hoursTotal: 0,
  playsThisMonth: 0,
  hoursThisMonth: 0,
});

/** den-edge for one paired library and its host grants. `edge.puts` holds every grant rewrite, in order. */
async function routeEdge(page, edge) {
  const generation = 'sharing-escrow';
  const headers = { 'x-den-generation': generation, 'x-den-wire-min': '4' };
  const rows = new Map();
  let head = 0;
  await guardNetwork(page);
  // Settings asks /routes when it opens. Until the answer arrives only installs on this page's own host are placed:
  // Atlas, on another of the deployment's names, is not yet known to be the household's.
  await page.route('**/routes', async (route) => {
    await new Promise((done) => setTimeout(done, 1_000));
    return route.fulfill({
      json: {
        addons: {
          den: [{ url: `${E2E_ORIGIN}/den` }],
          scout: [{ url: `${E2E_ORIGIN}/scout` }],
          atlas: [{ url: 'https://edge.example/atlas' }],
        },
      },
    });
  });
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'sharing-test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('**/oauth/connections', (route) => route.fulfill({ json: { connections: [] } }));
  // The library still lists Scout alongside combined Hearth. Sharing prefers Hearth without deleting the old
  // plugin; late route discovery still settles Atlas's placement while the first rewrite is in flight.
  const manifests = {
    'scout/fixture-install': { id: 'com.den.scout', resources: ['stream'] },
    'den/hearthcfg789': { id: 'com.den.hearth', resources: ['stream'] },
    'atlas/atlascfg456': { id: 'com.den.atlas', resources: ['catalog'] },
  };
  for (const [path, manifest] of Object.entries(manifests))
    await page.route(`${E2E_ORIGIN}/${path}/manifest.json`, (route) =>
      route.fulfill({ json: { version: '1.0.0', name: manifest.id, ...manifest } }),
    );
  // Hearth's playback capability probe: nothing to play here.
  await page.route(`${E2E_ORIGIN}/den/hearthcfg789/playback`, (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`${E2E_ORIGIN}/recovery`, (route) =>
    route.fulfill({ status: 403, json: { error: 'forbidden' } }),
  );
  await page.route(`${E2E_ORIGIN}/lib/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const grantPath = url.pathname.match(/\/grants(?:\/([0-9a-f]{8}))?$/);
    if (grantPath) {
      const [, gid] = grantPath;
      if (!gid && request.method() === 'GET')
        return route.fulfill({ headers, json: { grants: [...edge.grants.values()] } });
      if (gid && request.method() === 'PUT') {
        const change = request.postDataJSON();
        edge.puts.push({ gid, ...change });
        // den-edge answers a rewrite a little later than a read, as a store write does.
        await new Promise((done) => setTimeout(done, 150));
        const next = {
          ...edge.grants.get(gid),
          addons: change.addons,
          escrow: escrowOf(change.addons, change.installs),
        };
        edge.grants.set(gid, next);
        return route.fulfill({ headers, json: { grant: next } });
      }
    }
    if (url.pathname.endsWith('/member') && request.method() === 'PUT')
      return route.fulfill({ status: 200, headers });
    if (url.pathname.endsWith('/changes') && request.method() === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const entries = [...rows.values()].filter((entry) => entry.seq > since);
      return route.fulfill({ headers, json: { generation, entries, head, more: false } });
    }
    if (url.pathname.endsWith('/batch') && request.method() === 'POST') {
      const applied = [];
      const conflicts = [];
      for (const write of request.postDataJSON().writes) {
        const current = rows.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        const entry = { k: write.k, seq: ++head, v: write.v };
        rows.set(write.k, entry);
        applied.push({ k: write.k, seq: entry.seq });
      }
      return route.fulfill({ headers, json: { applied, conflicts } });
    }
    return route.abort('blockedbyclient');
  });
  await routeTmdb(page, (route) =>
    route.fulfill({ json: { page: 1, total_pages: 1, results: [] } }),
  );
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    }),
  );
}

/** Open Settings on the seeded library and wait until Sharing lists every guest and has stopped writing. */
async function openSharing(page, edge) {
  await page.goto(`${FIXTURE}?view=settings&online`);
  await page.getByRole('button', { name: 'Invite a guest Lend your addons' }).click();
  for (const { name } of edge.grants.values())
    await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible({
      timeout: 30_000,
    });
  // Quiet for three seconds: no rewrite is still on its way.
  let seen = -1;
  await expect
    .poll(
      () => {
        const settled = edge.puts.length === seen;
        seen = edge.puts.length;
        return settled;
      },
      { intervals: [3_000], timeout: 30_000 },
    )
    .toBe(true);
}

test('opening Sharing rewrites each stale invite once, and a current one never', async ({
  page,
}) => {
  const edge = {
    puts: [],
    grants: new Map(
      [
        // From before the Hearth migration, and one made since (Dana), already lending what is shared now.
        grant('a0000001', 'Alex', { scout: 'scoutcfg' }),
        grant('a0000002', 'Billie', { scout: 'scoutcfg', reel: 'reelcfg' }),
        grant('a0000003', 'Charlie', { scout: 'scoutcfg', atlas: 'atlascfg456' }),
        grant('a0000004', 'Dana', { den: 'hearthcfg789', atlas: 'atlascfg456' }),
      ].map((g) => [g.gid, g]),
    ),
  };
  await routeEdge(page, edge);
  await page.goto(`${FIXTURE}?seed&online&sharing`);
  await expect(page.getByRole('status').filter({ hasText: 'Worker library seeded' })).toBeVisible({
    timeout: 15_000,
  });

  await openSharing(page, edge);
  const wanted = {
    addons: ['den', 'atlas'],
    installs: { den: 'hearthcfg789', atlas: 'atlascfg456' },
  };
  expect(edge.puts.map(({ gid }) => gid).sort(), 'one rewrite per stale invite').toEqual([
    'a0000001',
    'a0000002',
    'a0000003',
  ]);
  for (const put of edge.puts) expect(put).toMatchObject(wanted);

  // Everything is current now: opening Sharing again writes nothing, and neither does a browser that never wrote
  // these grants itself (what den-edge says it holds is what counts, not what this browser remembers sending).
  for (const forget of [false, true]) {
    edge.puts.length = 0;
    if (forget) await page.evaluate(() => localStorage.removeItem('den.grants.uploaded'));
    await page.reload();
    await openSharing(page, edge);
    expect(edge.puts).toEqual([]);
  }
});
