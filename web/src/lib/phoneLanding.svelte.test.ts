import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { JoinResult } from './pair';

const GID = 'a1b2c3d4';
const TICKET = `${GID}.AAAAAAAAAAAAAAAAAAAAAA`;
const CODE = 'ABCDEFGH2345';
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 9);
const KEY = btoa(String.fromCharCode(...KEY_BYTES));
let kept: Map<string, string>;

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

async function world() {
  const { phoneLanding } = await import('./phoneLanding.svelte');
  const { guestGrants } = await import('./grants.svelte');
  const { links } = await import('./links.svelte');
  return { phoneLanding, guestGrants, links };
}

const spent = () =>
  new Response(JSON.stringify({ gid: GID, name: 'Sam', addons: ['scout'], expiresAt: null }));
const full = () =>
  new Response(JSON.stringify({ error: 'devices_full', name: 'Sam' }), { status: 409 });
const gone = () => new Response(JSON.stringify({ error: 'invalid_ticket' }), { status: 404 });

function edge(answer: () => Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer());
}

/** A pairing the laptop allowed: the handover carries the library key, as the sealed one does. */
const paired = (): JoinResult => ({
  handover: { host: 'Laptop', linkKey: new Uint8Array(32), libraryKey: KEY_BYTES },
  inboxKey: 'ab'.repeat(16),
});

test('the phone runs the pairing the link names, joins the library it hands over, then takes a slot', async () => {
  const { phoneLanding, guestGrants, links } = await world();
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  const moved: string[] = [];
  const join = vi.fn(async (_code: string) => paired());
  const fetchImpl = edge(spent);
  await phoneLanding.run(async (key) => (moved.push(key), true), { fetchImpl, join });

  expect(phoneLanding.phase).toBe('done');
  expect(join).toHaveBeenCalledWith(CODE, expect.anything());
  expect(moved).toEqual([KEY]);
  expect(links.current).toMatchObject({ libraryKey: KEY, guest: true });
  expect([phoneLanding.library, phoneLanding.addons, phoneLanding.host]).toEqual([
    'joined',
    'granted',
    'Sam',
  ]);

  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe('/grant/device');
  const sent = JSON.parse(String(init?.body)) as { ticket: string; secretHash: string };
  expect(sent.ticket).toBe(TICKET);
  const held = guestGrants.list.find((g) => g.gid === GID)!;
  expect(String(init?.body), 'only a hash of the phone’s own secret is sent').not.toContain(
    held.secret,
  );
  expect(kept.get('den.phoneLanding'), 'answered, so no longer kept').toBeUndefined();
});

test('a link already used or lapsed fails for good and takes nothing', async () => {
  const { phoneLanding, links } = await world();
  for (const error of ['claimed', 'expired'] as const) {
    phoneLanding.dismiss();
    phoneLanding.begin({ ticket: TICKET, code: CODE });
    const fetchImpl = edge(spent);
    await phoneLanding.run(async () => true, { fetchImpl, join: async () => ({ error }) });
    expect(phoneLanding.phase).toBe('failed');
    expect(phoneLanding.retryable).toBe(false);
    expect(phoneLanding.problem).toMatch(/Make a new one on your laptop/);
    expect(fetchImpl, 'no slot is spent without the library').not.toHaveBeenCalled();
    expect(links.current).toBeUndefined();
  }
});

test('a laptop that does not allow the phone leaves it with nothing', async () => {
  const { phoneLanding, links } = await world();
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  await phoneLanding.run(async () => true, { join: async () => ({ error: 'failed' }) });
  expect([phoneLanding.phase, phoneLanding.retryable]).toEqual(['failed', false]);
  expect(links.current).toBeUndefined();
});

test('at the device limit the phone still gets the library, without addons, and names whom to ask', async () => {
  const { phoneLanding, guestGrants, links } = await world();
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  await phoneLanding.run(async () => true, { fetchImpl: edge(full), join: async () => paired() });

  expect(phoneLanding.phase).toBe('done');
  expect(links.current).toMatchObject({ libraryKey: KEY });
  expect([phoneLanding.library, phoneLanding.addons, phoneLanding.host]).toEqual([
    'joined',
    'full',
    'Sam',
  ]);
  expect(guestGrants.list).toEqual([]);
});

test('a lapsed ticket costs the phone only its addons', async () => {
  const { phoneLanding, links } = await world();
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  await phoneLanding.run(async () => true, { fetchImpl: edge(gone), join: async () => paired() });
  expect(phoneLanding.addons).toBe('expired');
  expect(links.current?.libraryKey).toBe(KEY);
});

test('a link made after the grant ended pairs for the library and asks den-edge for no slot', async () => {
  const { phoneLanding } = await world();
  phoneLanding.begin({ ticket: null, code: CODE });
  const fetchImpl = edge(spent);
  await phoneLanding.run(async () => true, { fetchImpl, join: async () => paired() });
  expect([phoneLanding.phase, phoneLanding.addons]).toEqual(['done', 'none']);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a phone that already holds a synced library keeps it and does not trouble the laptop', async () => {
  const { phoneLanding, links } = await world();
  links.addRecovered('b3RoZXI=');
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  const join = vi.fn(async () => paired());
  await phoneLanding.run(null, { fetchImpl: edge(spent), join });
  expect(join).not.toHaveBeenCalled();
  expect(phoneLanding.library).toBe('kept');
  expect(links.current?.libraryKey).toBe('b3RoZXI=');
  expect(phoneLanding.addons, 'its addons still come').toBe('granted');
});

test('a phone that already holds the grant spends no second slot', async () => {
  const { phoneLanding, guestGrants } = await world();
  guestGrants.list = [
    {
      gid: GID,
      name: 'Sam',
      secret: 'own',
      addons: { scout: '/scout/~a1b2c3d4' },
      expiresAt: null,
      ended: false,
    },
  ];
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  const fetchImpl = edge(spent);
  await phoneLanding.run(async () => true, { fetchImpl, join: async () => paired() });
  expect(phoneLanding.addons).toBe('granted');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a library that cannot be moved, or den-edge out of reach, is retried without pairing again', async () => {
  const { phoneLanding, links } = await world();
  phoneLanding.begin({ ticket: TICKET, code: CODE });
  const join = vi.fn(async () => paired());
  await phoneLanding.run(async () => false, { fetchImpl: edge(spent), join });
  expect(phoneLanding.phase).toBe('failed');
  expect(phoneLanding.retryable).toBe(true);
  expect(links.current).toBeUndefined();
  expect(kept.get('den.phoneLanding'), 'kept, so a reload shows its answer').toBeDefined();

  phoneLanding.retry();
  const down = vi.fn(async () => {
    throw new TypeError('offline');
  });
  const move = vi.fn(async () => true);
  await phoneLanding.run(move, { fetchImpl: down, join });
  expect(phoneLanding.phase).toBe('failed');
  expect(links.current?.libraryKey).toBe(KEY);

  phoneLanding.retry();
  await phoneLanding.run(move, { fetchImpl: edge(spent), join });
  expect(phoneLanding.phase).toBe('done');
  expect(move, 'the library is not moved twice').toHaveBeenCalledTimes(1);
  expect(join, 'and the laptop is asked once').toHaveBeenCalledTimes(1);
});
