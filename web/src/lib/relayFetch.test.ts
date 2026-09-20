import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  forgetGrant,
  forgetLibraryCredential,
  onGrantEnded,
  relayFetch,
  rememberGrant,
  useLibraryCredential,
} from './relayFetch';

const KEYS = { id: 'abc123', member: 'def456' };
const HEADER = 'x-den-library-member';
const HERE = 'https://den.example/movie/157336';

type FetchSpy = ReturnType<typeof stub>;

/** The headers the last call actually carried, as a plain object. */
function sent(spy: FetchSpy): Record<string, string> {
  return Object.fromEntries(new Headers(spy.mock.calls.at(-1)?.[1]?.headers).entries());
}

function stub() {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => vi.stubGlobal('location', { href: HERE, origin: new URL(HERE).origin }));

afterEach(() => {
  forgetLibraryCredential();
  vi.unstubAllGlobals();
});

test('claims membership on the relayed addon and household API paths', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  for (const path of [
    '/scout/abc/manifest.json',
    '/atlas/recommend',
    '/reel/meta/movie/x.json',
    '/tmdb/3/movie/550',
    '/remux/health',
    '/remux/session',
    '/remux/releases',
  ]) {
    await relayFetch(path);
    expect(sent(spy)[HEADER]).toBe('abc123:def456');
  }
});

test('claims nothing anywhere else, on this origin or another', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  for (const url of [
    // Another origin borrowing a relayed path is the case this allow-list exists for: the token opens
    // the library to whoever holds it, so a matching path is not enough to be given one.
    'https://elsewhere.example/scout/stream/movie/tt1.json',
    'https://api.themoviedb.org/3/movie/157336',
    // Ours, but not relayed: remux and the library log take their own credentials, not this one.
    '/remux/hls/x.m3u8',
    '/lib/abc/log',
    '/scoutish/nope',
  ]) {
    await relayFetch(url);
    expect(sent(spy)[HEADER]).toBeUndefined();
  }
});

test('claims nothing when there is no page to judge the origin against', async () => {
  const spy = stub();
  vi.stubGlobal('location', undefined);
  useLibraryCredential(KEYS);
  await relayFetch('/atlas/recommend');
  expect(sent(spy)[HEADER]).toBeUndefined();
});

test('is plain fetch with no library open, and again once one is forgotten', async () => {
  const spy = stub();
  await relayFetch('/atlas/recommend');
  expect(sent(spy)[HEADER]).toBeUndefined();
  useLibraryCredential(KEYS);
  forgetLibraryCredential();
  await relayFetch('/atlas/recommend');
  expect(sent(spy)[HEADER]).toBeUndefined();
});

test('keeps the caller’s own headers and init', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  await relayFetch('/atlas/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  expect(sent(spy)['content-type']).toBe('application/json');
  expect(sent(spy)[HEADER]).toBe('abc123:def456');
  expect(spy.mock.calls.at(-1)?.[1]?.method).toBe('POST');
});

const GRANT = 'x-den-grant';
const GID = 'a1b2c3d4';

afterEach(() => {
  forgetGrant(GID);
  onGrantEnded(null);
});

test('a shared addon’s ~gid base carries the grant and never the library’s claim', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  rememberGrant(GID, 'sekrit');
  for (const path of [
    `/scout/~${GID}/manifest.json`,
    `/atlas/~${GID}/recommend`,
    `/reel/~${GID}/meta/movie/x.json`,
    `/subtitles/~${GID}/x`,
  ]) {
    await relayFetch(path, { headers: { [HEADER]: 'smuggled', a: 'b' } });
    expect(sent(spy)[GRANT], path).toBe(`${GID}:sekrit`);
    expect(sent(spy)[HEADER], path).toBeUndefined();
    expect(sent(spy).a).toBe('b');
  }
});

test('the grant is not attached to another origin, another path, or a grant it does not hold', async () => {
  const spy = stub();
  rememberGrant(GID, 'sekrit');
  for (const url of [
    `https://elsewhere.example/scout/~${GID}/manifest.json`,
    `/remux/s/abc/~${GID}`,
    '/scout/~ffffffff/manifest.json',
    `/tmdb/~${GID}/3/movie/1`,
  ]) {
    await relayFetch(url);
    expect(sent(spy)[GRANT], url).toBeUndefined();
  }
});

test('a session naming a shared install goes to the relay under the grant, not the membership', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  rememberGrant(GID, 'sekrit');
  const body = JSON.stringify({
    imdb: 'tt1',
    scout: `https://den.example/scout/~${GID}`,
    subtitles: `https://den.example/subtitles/~${GID}`,
  });
  for (const path of ['/remux/session', '/remux/releases']) {
    await relayFetch(path, { method: 'POST', body });
    expect(sent(spy)[GRANT], path).toBe(`${GID}:sekrit`);
    expect(sent(spy)[HEADER], path).toBeUndefined();
  }
});

test('a member who is also a guest plays their own library as a member', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  rememberGrant(GID, 'sekrit');
  await relayFetch('/remux/session', {
    method: 'POST',
    body: JSON.stringify({ imdb: 'tt1', scout: 'http://192.168.1.2:8080/sealed' }),
  });
  expect(sent(spy)[HEADER]).toBe('abc123:def456');
  expect(sent(spy)[GRANT]).toBeUndefined();
  await relayFetch('/remux/health');
  expect(sent(spy)[HEADER]).toBe('abc123:def456');
  expect(sent(spy)[GRANT]).toBeUndefined();
});

test('a guest with no library of their own probes the relay under their grant', async () => {
  const spy = stub();
  rememberGrant(GID, 'sekrit');
  await relayFetch('/remux/health');
  expect(sent(spy)[GRANT]).toBe(`${GID}:sekrit`);
  await relayFetch('/scout/sealed/manifest.json');
  expect(sent(spy)[GRANT]).toBeUndefined();
});

test('a grant_expired answer is passed on, and only that one', async () => {
  const ended = vi.fn();
  onGrantEnded(ended);
  rememberGrant(GID, 'sekrit');
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  answer(410, { error: 'gone' });
  await relayFetch(`/scout/~${GID}/manifest.json`);
  expect(ended).not.toHaveBeenCalled();
  answer(410, { error: 'grant_expired', expiredAt: 1 });
  const res = await relayFetch(`/scout/~${GID}/manifest.json`);
  expect(ended).toHaveBeenCalledWith(GID);
  // The caller still reads the body it was sent.
  expect(await res.json()).toEqual({ error: 'grant_expired', expiredAt: 1 });
});

test('takes a Request’s own url and headers', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  await relayFetch(
    new Request(`${new URL(HERE).origin}/scout/x/manifest.json`, { headers: { a: 'b' } }),
  );
  expect(sent(spy)[HEADER]).toBe('abc123:def456');
  expect(sent(spy).a).toBe('b');
});
