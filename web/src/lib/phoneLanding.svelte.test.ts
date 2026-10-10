import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const GID = 'a1b2c3d4';
const TICKET = `${GID}.AAAAAAAAAAAAAAAAAAAAAA`;
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 9)));
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

test('the phone joins the library, then takes a slot with a secret of its own', async () => {
  const { phoneLanding, guestGrants, links } = await world();
  phoneLanding.begin({ ticket: TICKET, libraryKey: KEY });
  const moved: string[] = [];
  const fetchImpl = edge(spent);
  await phoneLanding.run(async (key) => (moved.push(key), true), fetchImpl);

  expect(phoneLanding.phase).toBe('done');
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
  expect(sent.secretHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(kept.get('den.phoneLanding'), 'answered, so no longer kept').toBeUndefined();
});

test('at the device limit the phone still gets the library, without addons, and names whom to ask', async () => {
  const { phoneLanding, guestGrants, links } = await world();
  phoneLanding.begin({ ticket: TICKET, libraryKey: KEY });
  await phoneLanding.run(async () => true, edge(full));

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
  phoneLanding.begin({ ticket: TICKET, libraryKey: KEY });
  await phoneLanding.run(async () => true, edge(gone));
  expect(phoneLanding.addons).toBe('expired');
  expect(links.current?.libraryKey).toBe(KEY);
});

test('a link made after the grant ended brings the library and asks den-edge for nothing', async () => {
  const { phoneLanding } = await world();
  phoneLanding.begin({ ticket: null, libraryKey: KEY });
  const fetchImpl = edge(spent);
  await phoneLanding.run(async () => true, fetchImpl);
  expect([phoneLanding.phase, phoneLanding.addons]).toEqual(['done', 'none']);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a phone that already holds a synced library keeps it', async () => {
  const { phoneLanding, links } = await world();
  links.addRecovered('b3RoZXI=');
  phoneLanding.begin({ ticket: TICKET, libraryKey: KEY });
  const move = vi.fn(async () => true);
  await phoneLanding.run(move, edge(spent));
  expect(move).not.toHaveBeenCalled();
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
  phoneLanding.begin({ ticket: TICKET, libraryKey: KEY });
  const fetchImpl = edge(spent);
  await phoneLanding.run(async () => true, fetchImpl);
  expect(phoneLanding.addons).toBe('granted');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a library that cannot be moved, or den-edge out of reach, is retried without redoing what is done', async () => {
  const { phoneLanding, links } = await world();
  phoneLanding.begin({ ticket: TICKET, libraryKey: KEY });
  await phoneLanding.run(async () => false, edge(spent));
  expect(phoneLanding.phase).toBe('failed');
  expect(links.current).toBeUndefined();
  expect(kept.get('den.phoneLanding'), 'kept, so a reload resumes').toBeDefined();

  phoneLanding.retry();
  const down = vi.fn(async () => {
    throw new TypeError('offline');
  });
  const move = vi.fn(async () => true);
  await phoneLanding.run(move, down);
  expect(phoneLanding.phase).toBe('failed');
  expect(links.current?.libraryKey).toBe(KEY);

  phoneLanding.retry();
  await phoneLanding.run(move, edge(spent));
  expect(phoneLanding.phase).toBe('done');
  expect(move, 'the library is not moved twice').toHaveBeenCalledTimes(1);
});
