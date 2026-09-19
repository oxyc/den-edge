import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { forgetLibraryCredential, relayFetch, useLibraryCredential } from './relayFetch';

const KEYS = { id: 'abc123', token: 'def456' };
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

test('takes a Request’s own url and headers', async () => {
  const spy = stub();
  useLibraryCredential(KEYS);
  await relayFetch(
    new Request(`${new URL(HERE).origin}/scout/x/manifest.json`, { headers: { a: 'b' } }),
  );
  expect(sent(spy)[HEADER]).toBe('abc123:def456');
  expect(sent(spy).a).toBe('b');
});
