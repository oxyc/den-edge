import { describe, expect, it } from 'vitest';
import {
  directSource,
  directTrailer,
  directURL,
  nativeHls,
  trailerURL,
  trailerURLs,
  type DirectTrailer,
} from './reel';
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

describe('directURL', () => {
  it('keeps the signature and the mount, and only rewrites a play URL', () => {
    expect(directURL('https://pve.example:8443/reel/play/abc12345678.mp4?s=tag&i=iid')).toBe(
      'https://pve.example:8443/reel/direct/abc12345678.json?s=tag&i=iid',
    );
    expect(directURL('https://pve.example:8443/reel/crop/abc12345678.json')).toBeNull();
    expect(directURL('not a url')).toBeNull();
  });
});

describe('nativeHls', () => {
  it('believes a browser that claims it, and never throws', () => {
    expect(nativeHls(() => 'maybe')).toBe(true);
    expect(nativeHls(() => '')).toBe(false);
    expect(
      nativeHls(() => {
        throw new Error('no video element here');
      }),
    ).toBe(false);
  });
});

describe('directSource', () => {
  const both: DirectTrailer = {
    video: 'https://g/v',
    audio: 'https://g/a',
    hls: 'https://g/m.m3u8',
    width: 1920,
    height: 1080,
  };

  it('takes HLS wherever it plays, because it is the only source carrying sound', () => {
    expect(directSource(both, true, true)).toBe('https://g/m.m3u8');
    expect(directSource(both, false, true)).toBe('https://g/m.m3u8');
  });

  it('falls to the silent stream only where no one can turn the sound up', () => {
    expect(directSource(both, false, false)).toBe('https://g/v');
    // A viewer with controls would get a video that plays perfectly and is silent, saying nothing.
    expect(directSource(both, true, false)).toBeNull();
  });

  it('has nothing to offer without an answer', () => {
    expect(directSource(null, false, true)).toBeNull();
  });
});

describe('directTrailer', () => {
  const answer = (body: unknown, status = 200): typeof fetch =>
    (async (input) => {
      if (String(input) !== 'http://lan/direct/abc12345678.json?s=tag')
        return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const ask = (fetchImpl: typeof fetch) =>
    directTrailer('http://lan/play/abc12345678.mp4?s=tag', { fetchImpl });

  it('reads the streams reel resolved', async () => {
    expect(
      await ask(
        answer({
          video: 'https://rr7.googlevideo.com/videoplayback?itag=137',
          audio: 'https://rr7.googlevideo.com/videoplayback?itag=140',
          hls: 'https://manifest.googlevideo.com/index.m3u8',
          width: 1920,
          height: 1080,
        }),
      ),
    ).toEqual({
      video: 'https://rr7.googlevideo.com/videoplayback?itag=137',
      audio: 'https://rr7.googlevideo.com/videoplayback?itag=140',
      hls: 'https://manifest.googlevideo.com/index.m3u8',
      width: 1920,
      height: 1080,
    });
  });

  it('carries an answer with no master, and drops a plaintext one', async () => {
    const got = await ask(answer({ video: 'https://g/v', audio: null, hls: 'http://g/m.m3u8' }));
    expect(got?.hls).toBeNull();
    expect(got?.width).toBeNull();
  });

  it('is null for a reel that refuses, has no such route, or answers unusably', async () => {
    expect(await ask(answer({}, 403))).toBeNull();
    expect(await ask(answer({}, 404))).toBeNull();
    expect(await ask(answer({ video: 42 }))).toBeNull();
    expect(await ask(answer({ video: 'http://g/v' }))).toBeNull();
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
