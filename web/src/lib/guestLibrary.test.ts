import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { secretHash } from './grants';

const GID = 'a1b2c3d4';
let kept: Map<string, string>;

// The first dynamic import waits on the vite server to transform the Svelte-rune modules (the worker is idle, not
// computing) and later `vi.resetModules()` imports reuse that work. That wait is the one slow step in this file and
// is shared across every worker asking the same server, so it is paid in a hook instead of inside the first test.
beforeAll(async () => {
  stubStorage();
  await import('./guestLibrary');
  await import('./grants.svelte');
  await import('./links.svelte');
  await import('./wire');
  vi.unstubAllGlobals();
});

function stubStorage() {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('location', { href: 'https://den.example/', origin: 'https://den.example' });
}

beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  });
  vi.stubGlobal('location', { href: 'https://den.example/', origin: 'https://den.example' });
  vi.resetModules();
});

afterEach(() => vi.unstubAllGlobals());

/** Fresh singletons over this test's storage, with a live guest grant held. */
async function world() {
  const guestLibrary = await import('./guestLibrary');
  const { guestGrants } = await import('./grants.svelte');
  const { links } = await import('./links.svelte');
  guestGrants.list = [
    {
      gid: GID,
      name: 'Sam',
      secret: 'the-secret',
      addons: { scout: '/scout/~a1b2c3d4' },
      expiresAt: null,
      ended: false,
    },
  ];
  return { ...guestLibrary, guestGrants, links };
}

function edge(status: number) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status }),
  );
}

test('a guest with no synced library reserves one for its key, moves what it saved in, and holds it', async () => {
  const { startGuestLibrary, startingGrant, links } = await world();
  expect(startingGrant()?.gid).toBe(GID);
  const fetchImpl = edge(204);
  const moved: string[] = [];
  const outcome = await startGuestLibrary(
    startingGrant()!,
    async (key) => (moved.push(key), true),
    fetchImpl,
  );

  expect(outcome).toBe('started');
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe('/grant/library');
  expect(new Headers(init?.headers).get('x-den-grant')).toBe(`${GID}:the-secret`);
  const sent = JSON.parse(String(init?.body)) as { id: string; tokenHash: string };
  expect(sent.id).toMatch(/^[0-9a-f]{32}$/);
  expect(sent.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(String(init?.body)).not.toContain('the-secret');

  // The move runs once the reservation is made, and the browser then holds that very library.
  expect(moved).toHaveLength(1);
  expect(links.current).toMatchObject({ libraryKey: moved[0], recovered: true, guest: true });
  expect(startingGrant()).toBeUndefined();
});

test('the reservation names the token of the key the library is then opened with', async () => {
  const { startGuestLibrary, startingGrant } = await world();
  const { deriveKeys } = await import('./wire');
  const fetchImpl = edge(204);
  let key = '';
  await startGuestLibrary(startingGrant()!, async (k) => ((key = k), true), fetchImpl);
  const keys = await deriveKeys(Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
  expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
    id: keys.id,
    tokenHash: await secretHash(keys.token),
  });
});

test('a device that already holds a synced library keeps it and asks for nothing', async () => {
  const { startGuestLibrary, startingGrant, links } = await world();
  links.addRecovered('a'.repeat(43) + '=');
  const fetchImpl = edge(204);
  expect(startingGrant()).toBeUndefined();
  const grant = (await import('./grants.svelte')).guestGrants.list[0]!;
  expect(await startGuestLibrary(grant, async () => true, fetchImpl)).toBe('held');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a grant that already started its library elsewhere is refused once and not asked again', async () => {
  const { startGuestLibrary, startingGrant } = await world();
  const fetchImpl = edge(403);
  const move = vi.fn(async () => true);
  expect(await startGuestLibrary(startingGrant()!, move, fetchImpl)).toBe('held');
  expect(move).not.toHaveBeenCalled();
  expect(startingGrant(), 'not offered again').toBeUndefined();
  expect(
    await startGuestLibrary(
      (await import('./grants.svelte')).guestGrants.list[0]!,
      move,
      fetchImpl,
    ),
  ).toBe('held');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('a start that could not finish is retried with the same key', async () => {
  const { startGuestLibrary, startingGrant, links } = await world();
  const keys: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  // Offline: the move fails after the reservation was made.
  expect(
    await startGuestLibrary(startingGrant()!, async (k) => (keys.push(k), false), fetchImpl),
  ).toBe('failed');
  expect(links.current).toBeUndefined();
  // And den-edge unreachable.
  const down = vi.fn(async () => {
    throw new TypeError('offline');
  });
  expect(await startGuestLibrary(startingGrant()!, async (k) => (keys.push(k), true), down)).toBe(
    'failed',
  );

  expect(
    await startGuestLibrary(startingGrant()!, async (k) => (keys.push(k), true), fetchImpl),
  ).toBe('started');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bodies[0]).toBe(bodies[1]);
  expect(kept.get('den.guestLibrary.pending')).toBeUndefined();
});
