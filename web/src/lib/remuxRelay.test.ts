import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { forgetLibraryCredential, useLibraryCredential } from './relayFetch';
import { listReleases, startSession, type Want } from './remux';

const HEADER = 'x-den-library-member';
const HERE = 'https://den.example/movie/157336';
const WANT: Want = {
  imdb: 'tt0000001',
  scout: 'https://scout.example/abc',
  subtitles: [],
  subtitleLanguages: [],
  audio: [],
  videoCodecs: ['h264'],
};

function stub() {
  const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).endsWith('/releases')
      ? new Response(JSON.stringify({ releases: [] }))
      : new Response(JSON.stringify({ playlist: '/remux/s/id/sig/master.m3u8' }), { status: 201 }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function claim(spy: ReturnType<typeof stub>): string | null {
  return new Headers(spy.mock.calls.at(-1)?.[1]?.headers).get(HEADER);
}

beforeEach(() => vi.stubGlobal('location', { href: HERE, origin: new URL(HERE).origin }));

afterEach(() => {
  forgetLibraryCredential();
  vi.unstubAllGlobals();
});

// Away from home the control calls go through den-edge's member-gated relay, which answers a call with no claim as
// an unknown route (404). The session and releases calls used a plain `fetch`, so only the health probe carried one.
test('a session and its releases claim membership through the same-origin relay', async () => {
  const spy = stub();
  useLibraryCredential({ id: 'abc123', member: 'def456' });
  await startSession(WANT);
  expect(claim(spy)).toBe('abc123:def456');
  await listReleases(WANT);
  expect(claim(spy)).toBe('abc123:def456');
});

test('a direct den-remux address is given no claim, and neither is a page with no library open', async () => {
  const spy = stub();
  useLibraryCredential({ id: 'abc123', member: 'def456' });
  await startSession(WANT, undefined, 'https://home.example:8443/remux');
  expect(claim(spy)).toBeNull();
  forgetLibraryCredential();
  await startSession(WANT);
  expect(claim(spy)).toBeNull();
});
