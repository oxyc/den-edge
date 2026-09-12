import { describe, expect, it } from 'vitest';
import { trailerURL, trailerURLs } from './reel';
import type { Routes } from './routes';

const ROUTES: Routes = {
  reel: [
    { url: 'http://192.168.86.193:8092' },
    { url: 'https://pve.example:8443/reel' },
    { url: 'https://d-reel.oxy.fi', access: true },
  ],
};

/** reel, answering through den-edge's relay: it names its play URLs by the LAN address it was asked at. */
const answering = (body: unknown, status = 200): typeof fetch =>
  (async (input) => {
    if (String(input) !== '/reel/cfg/meta/movie/tt0111161.json')
      return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

const meta = {
  meta: {
    id: 'tt0111161',
    links: [
      {
        name: 'Trailer',
        category: 'Trailer',
        trailers: 'http://192.168.86.193:8092/play/abc123.mp4?s=tag&i=iid',
      },
      {
        name: 'Trailer',
        category: 'Trailer',
        trailers: 'http://192.168.86.193:8092/play/def456.mp4?s=tag2',
      },
    ],
  },
};

describe('trailerURL', () => {
  const ask = (routes: Routes, fetchImpl: typeof fetch, secure = true) =>
    trailerURL('/reel/cfg', 'movie', 'tt0111161', routes, { fetchImpl, secure });

  it('takes reel’s best trailer and points it at an address this page can reach, signature and all', async () => {
    expect(await ask(ROUTES, answering(meta))).toBe(
      'https://pve.example:8443/reel/play/abc123.mp4?s=tag&i=iid',
    );
  });

  it('stays on the LAN address when the page itself is plaintext', async () => {
    const onLan: Routes = { reel: [{ url: 'http://192.168.86.193:8092' }] };
    expect(await ask(onLan, answering(meta), false)).toBe(
      'http://192.168.86.193:8092/play/abc123.mp4?s=tag&i=iid',
    );
  });

  it('is null when reel has no trailer, answers badly, or has no address but an Access one', async () => {
    expect(await ask(ROUTES, answering({ meta: { links: [] } }))).toBeNull();
    expect(await ask(ROUTES, answering(meta, 503))).toBeNull();
    const sealed: Routes = { reel: [{ url: 'https://d-reel.oxy.fi', access: true }] };
    expect(await ask(sealed, answering(meta))).toBeNull();
  });
});

describe('trailer candidates', () => {
  it('keeps valid fallback videos after malformed entries, deduplicates and preserves signatures across mounts', async () => {
    const body = {
      meta: {
        links: [
          { trailers: 'invalid' },
          { trailers: 'javascript:alert(1)' },
          { trailers: 'https://old.example/reel/play/first.mp4?s=one' },
          { trailers: 'https://old.example/reel/play/first.mp4?s=one' },
          { trailers: 'http://lan/play/second.mp4?s=two' },
        ],
      },
    };
    expect(
      await trailerURLs('/reel/cfg', 'movie', 'tt0111161', ROUTES, {
        fetchImpl: answering(body),
        secure: true,
      }),
    ).toEqual([
      'https://pve.example:8443/reel/play/first.mp4?s=one',
      'https://pve.example:8443/reel/play/second.mp4?s=two',
    ]);
  });
});
