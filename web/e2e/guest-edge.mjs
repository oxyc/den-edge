// A den-edge for guests, in memory and shared by every browser context of a spec: invites that redeem, a grant's one
// library reserved and then started by its first write, device tickets with a slot limit, and the library log itself
// (`library-edge.mjs` answers one browser's; this one answers two). `edge` is what a spec reads and changes.
import { createHash, randomBytes } from 'node:crypto';
import { E2E_ORIGIN } from './base-url.mjs';
import { guardNetwork, routeTmdb } from './network.mjs';

export const GID = 'a1b2c3d4';
export const CODE = `${GID}.AAAAAAAAAAAAAAAAAAAAAA`;

const sha = (text) => createHash('sha256').update(text).digest('base64url');
const GENERATION = 'guest-library';
const HEADERS = { 'x-den-generation': GENERATION, 'x-den-wire-min': '4' };

export function newEdge({ devices = 2, host = 'Oskar', profiles = false } = {}) {
  return {
    host,
    profiles,
    /** The grant: device secret hashes, the slot limit, the one reserved library, and live or revoked. */
    grant: { devices: new Set(), limit: devices, reserved: null, live: true },
    tickets: new Set(),
    /** Libraries by id: the write token's hash, and the rows. */
    libraries: new Map(),
    refusedStarts: 0,
    /** Every `/lib` request: library id, action and wire; `refused` counts the 426s for an older wire. */
    libraryRequests: [],
    refused: 0,
    /** Guest Hearth capability probes, retained so specs can prove the grant—not library membership—authorized it. */
    playbackProbes: [],
    /** Pairing sessions by sid: the relay's four slots, as pairing v1 uses them. */
    pairs: new Map(),
    /** Ends every pairing session, as ten minutes do. */
    expirePairs() {
      for (const pair of this.pairs.values()) pair.ended = true;
    },
  };
}

const NAMEPLATE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** den-edge's `/pair` relay, in memory: it holds the messages and never sees the secret half of a code. */
async function routePairs(page, edge, origin) {
  await page.route(`${origin}/pair/**`, async (route) => {
    const request = route.request();
    const [, , first, slot] = new URL(request.url()).pathname.split('/');
    const method = request.method();
    if (first === 'new' && method === 'POST') {
      const { sid } = request.postDataJSON();
      let nameplate;
      do {
        nameplate = Array.from(randomBytes(4), (b) => NAMEPLATE[b & 31]).join('');
      } while ([...edge.pairs.values()].some((p) => p.nameplate === nameplate));
      edge.pairs.set(sid, { nameplate, claimed: false, ended: false, slots: new Map() });
      return json(route, 200, { nameplate });
    }
    if (first === 'open' && method === 'POST') {
      const { nameplate } = request.postDataJSON();
      const found = [...edge.pairs.entries()].find(([, p]) => p.nameplate === nameplate);
      if (!found || found[1].ended) return json(route, 410, { error: 'expired' });
      if (found[1].claimed) return json(route, 409, { error: 'claimed' });
      found[1].claimed = true;
      return json(route, 200, { sid: found[0] });
    }
    const pair = edge.pairs.get(first);
    if (!pair) return json(route, 410, { error: 'expired' });
    if (!slot && method === 'DELETE') {
      pair.ended = true;
      return route.fulfill({ status: 204 });
    }
    if (pair.ended) return json(route, 410, { error: 'expired' });
    if (method === 'PUT') {
      pair.slots.set(slot, request.postDataJSON().m);
      return route.fulfill({ status: 204 });
    }
    if (method === 'GET')
      return pair.slots.has(slot)
        ? json(route, 200, { m: pair.slots.get(slot) })
        : route.fulfill({ status: 202 });
    return json(route, 404, {});
  });
}

const json = (route, status, body, headers = {}) => route.fulfill({ status, json: body, headers });

/** Which device a `x-den-grant: <gid>:<secret>` is, or null when the grant is gone or the secret isn't one of its own. */
function holder(edge, request) {
  const [gid, secret] = (request.headers()['x-den-grant'] ?? '').split(':');
  return gid === GID && edge.grant.live && edge.grant.devices.has(sha(secret ?? '')) ? gid : null;
}

async function routeGrants(page, edge, origin) {
  await page.route(`${origin}/grant/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() ?? {};
    // A migrated owner keeps one combined Hearth install; no legacy Scout bearer remains in their library.
    const granted = { gid: GID, name: edge.host, addons: ['den'], expiresAt: null };
    if (path === '/grant/redeem') {
      if (body.code !== CODE || !edge.grant.live)
        return json(route, 404, { error: 'invalid_code' });
      if (!edge.grant.devices.has(body.secretHash) && edge.grant.devices.size >= edge.grant.limit)
        return json(route, 404, { error: 'invalid_code' });
      edge.grant.devices.add(body.secretHash);
      return json(route, 200, granted);
    }
    if (path === '/grant/addons') {
      if (!holder(edge, request)) return json(route, 404, { error: 'not_found' });
      return json(route, 200, {
        gid: GID,
        name: edge.host,
        expiresAt: null,
        addons: { den: `/den/~${GID}` },
      });
    }
    if (path === '/grant/library') {
      if (!holder(edge, request)) return json(route, 404, { error: 'not_found' });
      const same =
        edge.grant.reserved?.id === body.id && edge.grant.reserved?.tokenHash === body.tokenHash;
      if (edge.grant.reserved && !same) {
        edge.refusedStarts++;
        return json(route, 403, { error: 'new_libraries_closed' });
      }
      edge.grant.reserved = { id: body.id, tokenHash: body.tokenHash };
      return route.fulfill({ status: 204 });
    }
    if (path === '/grant/device-ticket') {
      if (!holder(edge, request)) return json(route, 404, { error: 'not_found' });
      const ticket = `${GID}.${randomBytes(16).toString('base64url')}`;
      edge.tickets.add(ticket);
      return json(route, 200, { ticket, expiresAt: Date.now() + 600_000 });
    }
    if (path === '/grant/device') {
      if (!edge.grant.live || !edge.tickets.has(body.ticket))
        return json(route, 404, { error: 'invalid_ticket' });
      if (!edge.grant.devices.has(body.secretHash) && edge.grant.devices.size >= edge.grant.limit)
        return json(route, 409, { error: 'devices_full', name: edge.host });
      edge.grant.devices.add(body.secretHash);
      edge.tickets.delete(body.ticket);
      return json(route, 200, granted);
    }
    return json(route, 404, {});
  });
}

async function routeLibraries(page, edge, origin) {
  await page.route(`${origin}/lib/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const [, , id, action] = url.pathname.split('/');
    const token = request.headers()['x-den-library-token'];
    const wire = request.headers()['x-den-wire'];
    let library = edge.libraries.get(id);
    edge.libraryRequests.push({ id, action, wire });
    // den-edge fences a library against clients on an older wire.
    if (library && Number(wire) < library.wireMin) {
      edge.refused++;
      return json(
        route,
        426,
        { error: 'upgrade_required' },
        { ...HEADERS, 'x-den-wire-min': String(library.wireMin) },
      );
    }
    if (action === 'member' && request.method() === 'PUT')
      return route.fulfill({ status: 200, headers: HEADERS });
    if (action === 'batch' && request.method() === 'POST') {
      if (!library) {
        // `NEW_LIBRARIES=members`: only the library a grant reserved for exactly this key may start.
        const reserved = edge.grant.reserved;
        const member = request.headers()['x-den-library-member']?.split(':')[0];
        const allowedByGrant =
          reserved && reserved.id === id && reserved.tokenHash === sha(token ?? '');
        const allowedByHousehold = edge.profiles && member && edge.libraries.has(member);
        if (!allowedByGrant && !allowedByHousehold) {
          edge.refusedStarts++;
          return json(route, 403, { error: 'new_libraries_closed' }, HEADERS);
        }
        library = {
          tokenHash: sha(token),
          rows: new Map(),
          head: 0,
          wireMin: Number(request.headers()['x-den-wire-min'] ?? 4),
        };
        edge.libraries.set(id, library);
      }
      const headers = { ...HEADERS, 'x-den-wire-min': String(library.wireMin) };
      if (library.tokenHash !== sha(token ?? ''))
        return json(route, 403, { error: 'forbidden' }, headers);
      const applied = [];
      const conflicts = [];
      for (const write of request.postDataJSON().writes) {
        const current = library.rows.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        const entry = { k: write.k, seq: ++library.head, v: write.v };
        library.rows.set(write.k, entry);
        applied.push({ k: write.k, seq: entry.seq });
      }
      return json(route, 200, { applied, conflicts }, headers);
    }
    if (action === 'changes' && request.method() === 'GET') {
      if (!library || library.tokenHash !== sha(token ?? '')) return json(route, 404, {}, HEADERS);
      const since = Number(url.searchParams.get('since') ?? 0);
      const before = url.searchParams.get('before');
      const keys = url.searchParams.get('keys');
      // Paged as den-edge pages it: a reader asking for few rows pays one round trip per page.
      const limit = Number(url.searchParams.get('limit') ?? 1000) || 1000;
      const rows = [...library.rows.values()];
      let read;
      if (keys !== null) {
        const named = new Set(keys.split(','));
        read = {
          entries: rows.filter((entry) => named.has(entry.k)).sort((a, b) => a.seq - b.seq),
          more: false,
          selected: true,
        };
      } else if (before !== null) {
        const below = rows
          .filter((entry) => entry.seq < Number(before))
          .sort((a, b) => b.seq - a.seq);
        read = {
          entries: below.slice(0, limit),
          more: below.length > limit,
          order: 'desc',
          rows: library.rows.size,
        };
      } else {
        const after = rows.filter((entry) => entry.seq > since).sort((a, b) => a.seq - b.seq);
        read = { entries: after.slice(0, limit), more: after.length > limit };
      }
      if (edge.changesLatencyMs)
        await new Promise((resolve) => setTimeout(resolve, edge.changesLatencyMs));
      return json(
        route,
        200,
        { generation: GENERATION, head: library.head, ...read },
        { ...HEADERS, 'x-den-wire-min': String(library.wireMin) },
      );
    }
    return route.abort('blockedbyclient');
  });
}

/** A browser of the guest's, pointed at `edge` and with every other request refused. */
export async function routeGuestEdge(page, edge, origin = E2E_ORIGIN) {
  // Playwright's page routes do not own a SharedWorker target, so its fetches would escape this in-memory edge and
  // could reach live metadata. These guest behavior specs deliberately take the production DedicatedWorker fallback;
  // the built-worker and Adaptive multi-context suites exercise SharedWorker itself.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'SharedWorker', {
      configurable: true,
      value: undefined,
    });
  });
  await guardNetwork(page);
  // The app's own pages and assets are the dev server's; any other call this origin could answer is "not here",
  // unless a route below says otherwise (they are registered later, so they win).
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const api =
      /^\/(?:tmdb|atlas|reel|scout|subs|subtitles|inbox|oauth|metadata|ratings|warnings|skipdb|playback|remux|lib|grant|pair|mcp|link|recovery|sync|routes|config|version)(?:\/|$)/.test(
        path,
      );
    return api ? route.fulfill({ status: 404, json: {} }) : route.continue();
  });
  // This page-level catch-all bypasses guardNetwork's context route when it continues to the dev server. Most guest
  // specs preserve the shipped default-off capability response; the profile provisioning regression opts in.
  await page.route(`${origin}/capabilities/profiles`, (route) =>
    edge.profiles
      ? route.fulfill({
          status: 200,
          headers: { 'cache-control': 'no-store' },
          json: { enabled: true },
        })
      : route.fulfill({
          status: 404,
          headers: { 'cache-control': 'no-store' },
          json: { error: 'not_found' },
        }),
  );
  await page.route('**/routes', (route) => route.fulfill({ json: {} }));
  await page.route('**/version', (route) => route.fulfill({ json: { version: 'guest-test' } }));
  await page.route('**/config', (route) => route.fulfill({ json: {} }));
  await page.route('**/oauth/connections', (route) => route.fulfill({ json: { connections: [] } }));
  await page.route(`${origin}/recovery`, (route) => route.fulfill({ json: { entries: [] } }));
  await page.route(`${origin}/scout/**`, (route) =>
    route.fulfill({
      json: { id: 'com.den.scout', name: 'Scout', version: '1.0.0', resources: [] },
    }),
  );
  await page.route(`${origin}/den/~${GID}/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/den/~${GID}/manifest.json`)
      return route.fulfill({
        json: { id: 'com.den.hearth', name: 'Hearth', version: '1.0.0', resources: ['stream'] },
      });
    if (path === `/den/~${GID}/playback` && request.method() === 'OPTIONS') {
      edge.playbackProbes.push({ url: request.url(), headers: request.headers() });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await routeGrants(page, edge, origin);
  await routeLibraries(page, edge, origin);
  await routePairs(page, edge, origin);
  await routeTmdb(page, (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/movie\/(\d+)$/);
    if (!match) return route.fulfill({ json: { page: 1, total_pages: 1, results: [] } });
    return route.fulfill({
      json: {
        id: Number(match[1]),
        title: `Movie ${match[1]}`,
        release_date: '2026-01-01',
        overview: 'A movie, for the detail page to show.',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        vote_average: 7.5,
        vote_count: 500,
        genres: [{ id: 18 }],
        credits: { cast: [], crew: [] },
        recommendations: { results: [] },
        external_ids: {},
      },
    });
  });
  await page.route('https://image.tmdb.org/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"/>',
    }),
  );
}
