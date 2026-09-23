import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  cappedCodeExpiry,
  createGrant,
  DAY,
  grantAddons,
  hashInstalls,
  inviteLink,
  keepCode,
  keptCodes,
  leaveGrant,
  listGrants,
  newSecret,
  parseInvite,
  redeem,
  reuploadInstalls,
  revokeGrant,
  secretHash,
  sharedInstallOf,
  timeLeft,
  updateGrant,
  type Grant,
} from './grants';
import { forgetLibraryCredential, relayFetch, useLibraryCredential } from './relayFetch';

test('a code expiry stays a day inside den-edge’s 90-day limit, whatever the browser clock says', () => {
  expect(cappedCodeExpiry(1000, 14 * DAY)).toBe(1000 + 14 * DAY);
  expect(cappedCodeExpiry(1000, 200 * DAY)).toBe(1000 + 89 * DAY);
});

const HERE = 'https://den.example/settings';
const CODE = 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA';
const MEMBER = 'x-den-library-member';

const GRANT: Grant = {
  gid: 'a1b2c3d4',
  name: 'Sam',
  status: 'active',
  addons: ['scout', 'atlas'],
  createdAt: 1,
  codeExpiresAt: 2,
  accessDays: 7,
  accessUntil: null,
  redeemedAt: 3,
  expiresAt: 4,
  devices: 1,
  deviceCount: 1,
  lastUsedAt: null,
};

function stubStorage() {
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  });
}

/** A fetch answering with `body` at `status`, and the calls it saw. */
function answering(status: number, body?: unknown) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}

beforeEach(() => {
  vi.stubGlobal('location', { href: HERE, origin: 'https://den.example' });
  stubStorage();
});

afterEach(() => {
  forgetLibraryCredential();
  vi.unstubAllGlobals();
});

test('a secret is 256 random bits of base64url, never the same twice', () => {
  const [a, b] = [newSecret(), newSecret()];
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(b);
});

test('the secret hash is the base64url SHA-256 of the string’s own ASCII bytes', async () => {
  // SHA-256("abc"), the FIPS 180 vector, in base64url.
  expect(await secretHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});

test('an invite is read from a code or from the link that carries it, and from nothing else', () => {
  expect(parseInvite(CODE)).toBe(CODE);
  expect(parseInvite(`  ${CODE}\n`)).toBe(CODE);
  expect(parseInvite(inviteLink('https://den.example', CODE))).toBe(CODE);
  expect(parseInvite(`#invite=${CODE}`)).toBe(CODE);
  for (const bad of [
    '',
    'nope',
    'A1B2C3D4.AAAAAAAAAAAAAAAAAAAAAA',
    `${CODE}x`,
    '#pair=ABCD',
    '#invite=x',
  ])
    expect(parseInvite(bad), bad).toBeNull();
});

test('an invite’s code is kept to copy again until it is used, and then forgotten', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage;
  keepCode('aaaa0001', 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA', storage);
  keepCode('bbbb0002', 'b1b2c3d4.BBBBBBBBBBBBBBBBBBBBBB', storage);
  expect(keptCodes(['aaaa0001', 'bbbb0002'], storage)).toEqual({
    aaaa0001: 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA',
    bbbb0002: 'b1b2c3d4.BBBBBBBBBBBBBBBBBBBBBB',
  });
  // bbbb0002 was redeemed or revoked: no longer unused.
  expect(keptCodes(['aaaa0001'], storage)).toEqual({ aaaa0001: 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA' });
  expect(keptCodes(undefined, storage)).toEqual({ aaaa0001: 'a1b2c3d4.AAAAAAAAAAAAAAAAAAAAAA' });
});

test('a shared install is one of this origin’s own ~gid bases, and nothing else', () => {
  expect(sharedInstallOf('https://den.example/scout/~a1b2c3d4/manifest.json')).toEqual({
    addon: 'scout',
    gid: 'a1b2c3d4',
    path: '/scout/~a1b2c3d4',
    install: 'https://den.example/scout/~a1b2c3d4',
  });
  for (const other of [
    'https://elsewhere.example/scout/~a1b2c3d4/manifest.json',
    'https://den.example/scout/sealed/manifest.json',
    'https://den.example/scout/~A1B2C3D4/manifest.json',
    'https://den.example/scout/~a1b2c3d4/../x/manifest.json',
    'https://den.example/remux/~a1b2c3d4',
  ])
    expect(sharedInstallOf(other), other).toBeNull();
});

test('time left is said in the largest whole unit', () => {
  const now = 1_000_000_000;
  expect(timeLeft(null, now)).toBe('No end date');
  expect(timeLeft(now - 1, now)).toBe('Ended');
  expect(timeLeft(now + 6.2 * 86_400_000, now)).toBe('7 days');
  expect(timeLeft(now + 86_400_000, now)).toBe('1 day');
  expect(timeLeft(now + 5 * 3_600_000 - 1, now)).toBe('5 hours');
  expect(timeLeft(now + 30_000, now)).toBe('1 minute');
});

test('an install hash follows only the addons asked about', async () => {
  const installs = { scout: 'one', atlas: 'two' };
  const first = await hashInstalls(installs, ['scout']);
  expect(await hashInstalls({ ...installs, atlas: 'changed' }, ['scout'])).toBe(first);
  expect(await hashInstalls({ ...installs, scout: 'changed' }, ['scout'])).not.toBe(first);
});

test('creating a grant posts the invite to the library’s own grants route, with the membership proof', async () => {
  const spy = answering(201, { gid: 'a1b2c3d4', code: CODE, grant: GRANT });
  vi.stubGlobal('fetch', spy);
  useLibraryCredential({ id: 'abc123', member: 'def456' });
  const reply = await createGrant(
    'abc123',
    { name: 'Sam', addons: ['scout'], installs: { scout: 'cfg' }, accessDays: 7 },
    relayFetch,
  );
  expect(reply).toEqual({ ok: true, value: { code: CODE, grant: GRANT } });
  const [url, init] = spy.mock.calls[0]!;
  expect(url).toBe('/lib/abc123/grants');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({
    name: 'Sam',
    addons: ['scout'],
    installs: { scout: 'cfg' },
    accessDays: 7,
  });
  expect(new Headers(init?.headers).get(MEMBER)).toBe('abc123:def456');
});

test('another library’s grants route never gets this library’s membership proof', async () => {
  const spy = answering(200, { grants: [] });
  vi.stubGlobal('fetch', spy);
  useLibraryCredential({ id: 'abc123', member: 'def456' });
  await relayFetch('/lib/ffff/grants');
  expect(new Headers(spy.mock.calls[0]![1]?.headers).get(MEMBER)).toBeNull();
});

test('listing, changing and revoking use the grant’s route and read the answer', async () => {
  const spy = answering(200, { grants: [GRANT, { nonsense: true }], grant: GRANT });
  expect(await listGrants('abc123', spy)).toEqual({ ok: true, value: [GRANT] });
  expect(await updateGrant('abc123', 'a1b2c3d4', { name: 'Sam T' }, spy)).toEqual({
    ok: true,
    value: GRANT,
  });
  expect(spy.mock.calls[1]![0]).toBe('/lib/abc123/grants/a1b2c3d4');
  expect(spy.mock.calls[1]![1]?.method).toBe('PUT');
  const gone = answering(204);
  expect(await revokeGrant('abc123', 'a1b2c3d4', gone)).toEqual({ ok: true, value: null });
  expect(gone.mock.calls[0]![1]?.method).toBe('DELETE');
});

test('a refusal carries den-edge’s error code, and an unreachable one says so', async () => {
  const full = answering(409, { error: 'too_many_grants' });
  expect(await createGrant('abc123', { name: 'x', addons: ['scout'], installs: {} }, full)).toEqual(
    {
      ok: false,
      status: 409,
      error: 'too_many_grants',
    },
  );
  const down = vi.fn(async () => {
    throw new TypeError('offline');
  });
  expect(await listGrants('abc123', down)).toEqual({ ok: false, status: 0, error: 'unreachable' });
});

test('redeeming sends the code and the hash of the secret, never the secret', async () => {
  const spy = answering(200, {
    gid: 'a1b2c3d4',
    name: 'Sam',
    addons: ['scout', 'bogus'],
    expiresAt: 5,
  });
  const secret = newSecret();
  const reply = await redeem(CODE, secret, spy);
  expect(reply).toEqual({
    ok: true,
    value: { gid: 'a1b2c3d4', name: 'Sam', addons: ['scout'], expiresAt: 5 },
  });
  const [url, init] = spy.mock.calls[0]!;
  expect(url).toBe('/grant/redeem');
  expect(JSON.parse(String(init?.body))).toEqual({
    code: CODE,
    secretHash: await secretHash(secret),
  });
  expect(String(init?.body)).not.toContain(secret);
});

test('the guest’s calls carry the grant header explicitly, and the addons are only this grant’s own bases', async () => {
  const spy = answering(200, {
    name: 'Sam',
    expiresAt: null,
    addons: {
      scout: '/scout/~a1b2c3d4',
      atlas: '/atlas/~ffffffff',
      reel: 'https://evil.example/x',
    },
  });
  const reply = await grantAddons('a1b2c3d4', 'sekrit', spy);
  expect(reply).toEqual({
    ok: true,
    value: { name: 'Sam', expiresAt: null, addons: { scout: '/scout/~a1b2c3d4' } },
  });
  expect(new Headers(spy.mock.calls[0]![1]?.headers).get('x-den-grant')).toBe('a1b2c3d4:sekrit');
  expect(spy.mock.calls[0]![0]).toBe('/grant/addons');

  const ended = answering(410, { error: 'grant_expired' });
  expect(await grantAddons('a1b2c3d4', 'sekrit', ended)).toMatchObject({
    ok: false,
    error: 'grant_expired',
  });

  const left = answering(204);
  expect(await leaveGrant('a1b2c3d4', 'sekrit', left)).toEqual({ ok: true, value: null });
  expect(left.mock.calls[0]![0]).toBe('/grant/a1b2c3d4');
  expect(left.mock.calls[0]![1]?.method).toBe('DELETE');
});

test('escrow is re-uploaded only for a live grant whose addons changed, and only once', async () => {
  const spy = answering(200, { grant: GRANT });
  const installs = { scout: 'one', atlas: 'two', reel: 'three' };
  const expired: Grant = { ...GRANT, gid: 'deadbeef', status: 'expired' };
  const needsMore: Grant = { ...GRANT, gid: 'cafef00d', addons: ['scout', 'subtitles'] };

  expect(await reuploadInstalls('abc123', [GRANT, expired, needsMore], installs, spy)).toEqual([
    'a1b2c3d4',
  ]);
  expect(spy).toHaveBeenCalledTimes(1);
  // Only the addons this grant shares travel with it.
  expect(JSON.parse(String(spy.mock.calls[0]![1]?.body))).toEqual({
    installs: { scout: 'one', atlas: 'two' },
  });

  // Nothing changed for it: no churn, even though another addon did.
  expect(await reuploadInstalls('abc123', [GRANT], { ...installs, reel: 'changed' }, spy)).toEqual(
    [],
  );
  expect(spy).toHaveBeenCalledTimes(1);

  expect(await reuploadInstalls('abc123', [GRANT], { ...installs, atlas: 'rotated' }, spy)).toEqual(
    ['a1b2c3d4'],
  );
  expect(spy).toHaveBeenCalledTimes(2);
});

test('a failed upload is tried again next time', async () => {
  const installs = { scout: 'one', atlas: 'two' };
  const failing = answering(500, { error: 'boom' });
  expect(await reuploadInstalls('abc123', [GRANT], installs, failing)).toEqual([]);
  const working = answering(200, { grant: GRANT });
  expect(await reuploadInstalls('abc123', [GRANT], installs, working)).toEqual(['a1b2c3d4']);
});

test('nothing breaks where browser storage is refused', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  const spy = answering(200, { grant: GRANT });
  expect(await reuploadInstalls('abc123', [GRANT], { scout: 'one', atlas: 'two' }, spy)).toEqual([
    'a1b2c3d4',
  ]);
});
