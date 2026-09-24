import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GuestGrants } from './grants.svelte';
import { forgetGrant, onGrantEnded, relayFetch } from './relayFetch';

const CODE = 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA';
const GID = 'a1b2c3d4';
const KEY = 'den.grants';

let kept: Map<string, string>;

function stubStorage() {
  kept = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  });
}

/** Answers by route, and records what was sent. */
function edge(routes: Record<string, () => Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = `${init?.method ?? 'GET'} ${String(input)}`;
    const answer = routes[route];
    if (!answer) throw new Error(`unexpected ${route}`);
    return answer();
  });
  return spy;
}

const redeemed = () =>
  new Response(
    JSON.stringify({ gid: GID, name: 'Sam', addons: ['scout', 'atlas'], expiresAt: 9e12 }),
  );

beforeEach(() => {
  vi.stubGlobal('location', {
    href: 'https://den.example/settings',
    origin: 'https://den.example',
  });
  stubStorage();
});

afterEach(() => {
  forgetGrant(GID);
  onGrantEnded(null);
  vi.unstubAllGlobals();
});

test('redeeming keeps the grant in browser storage, and only there', async () => {
  const grants = new GuestGrants();
  const result = await grants.redeem(
    `https://den.example/#invite=${CODE}`,
    edge({ 'POST /grant/redeem': redeemed }),
  );
  expect(result).toMatchObject({ gid: GID, name: 'Sam', ended: false });
  expect(grants.list).toHaveLength(1);
  expect(grants.pluginUrls()).toEqual([
    'https://den.example/scout/~a1b2c3d4/manifest.json',
    'https://den.example/atlas/~a1b2c3d4/manifest.json',
  ]);
  expect(JSON.parse(kept.get(KEY)!)[0]).toMatchObject({
    gid: GID,
    addons: { scout: '/scout/~a1b2c3d4' },
  });
  // A new page load finds it again, and the relay can use it at once.
  const later = new GuestGrants();
  expect(later.list.map((g) => g.gid)).toEqual([GID]);
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
  vi.stubGlobal('fetch', spy);
  await relayFetch('/scout/~a1b2c3d4/manifest.json');
  const secret = later.list[0]!.secret;
  expect(new Headers(spy.mock.calls[0]![1]?.headers).get('x-den-grant')).toBe(`${GID}:${secret}`);
});

test('a retry after a lost answer redeems with the same secret', async () => {
  const grants = new GuestGrants();
  const hashes: string[] = [];
  let lost = true;
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    hashes.push(JSON.parse(String(init?.body)).secretHash);
    if (lost) throw new TypeError('offline');
    return redeemed();
  });
  expect(await grants.redeem(CODE, fetchImpl)).toBe('unreachable');
  lost = false;
  expect(await grants.redeem(CODE, fetchImpl)).toMatchObject({ gid: GID });
  expect(hashes[0]).toBe(hashes[1]);
});

test('a retry after a lost answer and a reload redeems with the same secret', async () => {
  const hashes: string[] = [];
  let lost = true;
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    hashes.push(JSON.parse(String(init?.body)).secretHash);
    if (lost) throw new TypeError('offline');
    return redeemed();
  });
  expect(await new GuestGrants().redeem(CODE, fetchImpl)).toBe('unreachable');
  lost = false;
  const reloaded = new GuestGrants();
  expect(await reloaded.redeem(CODE, fetchImpl)).toMatchObject({ gid: GID });
  expect(hashes[0]).toBe(hashes[1]);
  expect(kept.has('den.grants.pending'), 'forgotten once redeemed').toBe(false);
  // The grant holds the secret den-edge has the hash of.
  expect(reloaded.list[0]?.secret).toBeTruthy();
});

test('a bad or refused code says which, and stores nothing', async () => {
  const grants = new GuestGrants();
  expect(await grants.redeem('nonsense')).toBe('malformed');
  const no = (status: number) =>
    edge({ 'POST /grant/redeem': () => new Response('{"error":"invalid_code"}', { status }) });
  expect(await grants.redeem(CODE, no(404))).toBe('invalid');
  expect(await grants.redeem(CODE, no(429))).toBe('throttled');
  expect(grants.list).toEqual([]);
  expect(kept.has(KEY)).toBe(false);
});

test('an invite that arrived in the address waits for the viewer, and is cleared once redeemed', async () => {
  const grants = new GuestGrants();
  grants.invite = CODE;
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  expect(grants.invite).toBeNull();
});

test('a grant den-edge says has expired is kept, said so, and no longer asked with', async () => {
  const grants = new GuestGrants();
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  await grants.refresh(
    edge({
      'GET /grant/addons': () =>
        new Response('{"error":"grant_expired","expiredAt":1}', { status: 410 }),
    }),
  );
  expect(grants.list[0]!.ended).toBe(true);
  expect(grants.endedText()).toBe('Your access to Sam ended');
  expect(grants.pluginUrls()).toEqual([]);
  const spy = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', spy);
  await relayFetch('/scout/~a1b2c3d4/manifest.json');
  expect(
    new Headers((spy.mock.calls[0] as unknown as [string, RequestInit?])[1]?.headers).get(
      'x-den-grant',
    ),
  ).toBeNull();
});

test('an expired grant is asked again, and comes back once the host extends it', async () => {
  const grants = new GuestGrants();
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  await grants.refresh(
    edge({ 'GET /grant/addons': () => new Response('{"error":"grant_expired"}', { status: 410 }) }),
  );
  expect(grants.list[0]!.ended).toBe(true);
  expect(grants.list[0]!.secret).not.toBe('');
  await grants.refresh(
    edge({
      'GET /grant/addons': () =>
        new Response(
          JSON.stringify({ name: 'Sam', expiresAt: 9e12, addons: { scout: '/scout/~a1b2c3d4' } }),
        ),
    }),
  );
  expect(grants.list[0]).toMatchObject({ ended: false, expiresAt: 9e12 });
  expect(grants.endedText()).toBeNull();
  const spy = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', spy);
  await relayFetch('/scout/~a1b2c3d4/manifest.json');
  expect(
    new Headers((spy.mock.calls[0] as unknown as [string, RequestInit?])[1]?.headers).get(
      'x-den-grant',
    ),
  ).toBe(`${GID}:${grants.list[0]!.secret}`);
});

test('a grant den-edge no longer knows ended for good: its secret is dropped and it is not asked again', async () => {
  const grants = new GuestGrants();
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  await grants.refresh(
    edge({ 'GET /grant/addons': () => new Response('{"error":"not_found"}', { status: 404 }) }),
  );
  expect(grants.list[0]).toMatchObject({ ended: true, secret: '' });
  expect(grants.endedText()).toBe('Your access to Sam ended');
  const again = vi.fn();
  await grants.refresh(again);
  expect(again).not.toHaveBeenCalled();
});

test('a relayed call answered grant_expired ends the grant too', async () => {
  const grants = new GuestGrants();
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"error":"grant_expired"}', { status: 410 })),
  );
  await relayFetch('/scout/~a1b2c3d4/manifest.json');
  expect(grants.list[0]!.ended).toBe(true);
  expect(JSON.parse(kept.get(KEY)!)[0].ended).toBe(true);
});

test('a refresh brings a renamed host and a moved end date, and leaves an unreachable one alone', async () => {
  const grants = new GuestGrants();
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  await grants.refresh(
    edge({
      'GET /grant/addons': () =>
        new Response(
          JSON.stringify({ name: 'Sam T', expiresAt: 1, addons: { scout: '/scout/~a1b2c3d4' } }),
        ),
    }),
  );
  expect(grants.list[0]).toMatchObject({
    name: 'Sam T',
    expiresAt: 1,
    addons: { scout: '/scout/~a1b2c3d4' },
  });
  await grants.refresh(edge({ 'GET /grant/addons': () => new Response('{}', { status: 503 }) }));
  expect(grants.list[0]).toMatchObject({ name: 'Sam T', ended: false });
});

test('leaving tells den-edge, forgets the grant and its secret; an unreachable den-edge keeps it to retry', async () => {
  const grants = new GuestGrants();
  await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }));
  const down = vi.fn(async () => {
    throw new TypeError('offline');
  });
  expect(await grants.leave(GID, down)).toBe(false);
  expect(grants.list).toHaveLength(1);
  const fetchImpl = edge({ 'DELETE /grant/a1b2c3d4': () => new Response(null, { status: 204 }) });
  expect(await grants.leave(GID, fetchImpl)).toBe(true);
  expect(grants.list).toEqual([]);
  expect(JSON.parse(kept.get(KEY)!)).toEqual([]);
  const spy = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', spy);
  await relayFetch('/scout/~a1b2c3d4/manifest.json');
  expect(
    new Headers((spy.mock.calls[0] as unknown as [string, RequestInit?])[1]?.headers).get(
      'x-den-grant',
    ),
  ).toBeNull();
});

test('works for the visit where browser storage is refused', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  const grants = new GuestGrants();
  expect(grants.list).toEqual([]);
  expect(await grants.redeem(CODE, edge({ 'POST /grant/redeem': redeemed }))).toMatchObject({
    gid: GID,
  });
  expect(grants.pluginUrls()).toHaveLength(2);
});

test('ignores stored records that are not grants', () => {
  kept.set(KEY, JSON.stringify([{ gid: 'nope' }, 'x', null]));
  expect(new GuestGrants().list).toEqual([]);
  kept.set(KEY, '{not json');
  expect(new GuestGrants().list).toEqual([]);
});
