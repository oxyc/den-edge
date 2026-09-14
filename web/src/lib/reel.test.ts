import { describe, expect, it } from 'vitest';
import {
  directTrailer,
  directURL,
  hlsURL,
  nativeHls,
  trailerSource,
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
const answering = (body: unknown, status = 200, at = '/reel/cfg'): typeof fetch =>
  (async (input) => {
    if (String(input) !== `${at}/meta/movie/tt0111161.json`)
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
    trailerURL('/reel/cfg', 'movie', { imdb: 'tt0111161' }, routes, { fetchImpl, secure });

  it('takes reel’s best trailer and keeps it on this origin, signature and all', async () => {
    // The relay's mount, not the install's config: a play URL is signed rather than configured. And not
    // one of reel's own addresses — on a public name the tailnet one resolves for nobody and the public
    // one is behind Access, which is a trailer that silently never plays.
    expect(await ask(ROUTES, answering(meta))).toBe('/reel/play/abc123.mp4?s=tag&i=iid');
  });

  it('falls back to an address this page can reach where reel is not on this origin', async () => {
    const elsewhere = (routes: Routes, secure = true) =>
      trailerURL('https://reel.example/cfg', 'movie', { imdb: 'tt0111161' }, routes, {
        fetchImpl: answering(meta, 200, 'https://reel.example/cfg'),
        secure,
      });
    expect(await elsewhere(ROUTES)).toBe(
      'https://pve.example:8443/reel/play/abc123.mp4?s=tag&i=iid',
    );
    const onLan: Routes = { reel: [{ url: 'http://192.168.86.193:8092' }] };
    expect(await elsewhere(onLan, false)).toBe(
      'http://192.168.86.193:8092/play/abc123.mp4?s=tag&i=iid',
    );
    const sealed: Routes = { reel: [{ url: 'https://d-reel.oxy.fi', access: true }] };
    expect(await elsewhere(sealed), 'nothing but an Access address is nothing to play').toBeNull();
  });

  it('is null when reel has no trailer or answers badly', async () => {
    expect(await ask(ROUTES, answering({ meta: { links: [] } }))).toBeNull();
    expect(await ask(ROUTES, answering(meta, 503))).toBeNull();
  });
});

describe('directURL', () => {
  it('keeps the signature and the mount, and only rewrites a play URL', () => {
    expect(directURL('https://pve.example:8443/reel/play/abc12345678.mp4?s=tag&i=iid')).toBe(
      'https://pve.example:8443/reel/direct/abc12345678.json?s=tag&i=iid',
    );
    expect(directURL('https://pve.example:8443/reel/crop/abc12345678.json')).toBeNull();
    expect(directURL('not a url')).toBeNull();
    // A relayed play URL is a path on this origin, and its lookup has to stay one.
    expect(directURL('/reel/play/abc12345678.mp4?s=tag')).toBe(
      '/reel/direct/abc12345678.json?s=tag',
    );
  });
});

describe('hlsURL', () => {
  it('is the play URL’s HLS sibling, signature and all', () => {
    expect(hlsURL('/reel/play/abc12345678.mp4?s=tag')).toBe('/reel/hls/abc12345678.m3u8?s=tag');
    expect(hlsURL('https://pve.example:8443/reel/play/abc12345678.mp4?s=tag&i=iid')).toBe(
      'https://pve.example:8443/reel/hls/abc12345678.m3u8?s=tag&i=iid',
    );
    expect(hlsURL('https://pve.example:8443/reel/crop/abc12345678.json')).toBeNull();
  });
});

describe('trailerSource', () => {
  const play = '/reel/play/abc12345678.mp4?s=tag';
  const direct: DirectTrailer = {
    video: 'https://g/v',
    audio: null,
    hls: 'https://g/m.m3u8',
    width: null,
    height: null,
  };

  /** Nothing crosses the homelab at all where the browser can fetch Google's master itself. */
  it('takes YouTube’s own master where the browser plays HLS natively', () => {
    expect(trailerSource(play, direct, true)).toBe('https://g/m.m3u8');
  });

  /** googlevideo sends MSE no CORS header, so reel's copy of the master is the only fetchable one. */
  it('takes reel’s proxy of that master everywhere else', () => {
    expect(trailerSource(play, direct, false)).toBe('/reel/hls/abc12345678.m3u8?s=tag');
  });

  it('has nothing to offer when the resolve found no master', () => {
    expect(trailerSource(play, { ...direct, hls: null }, false)).toBeNull();
    expect(trailerSource(play, null, true)).toBeNull();
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
      await trailerURLs('/reel/cfg', 'movie', { imdb: 'tt0111161' }, ROUTES, {
        fetchImpl: answering(body),
        secure: true,
      }),
    ).toEqual(['/reel/play/first.mp4?s=one', '/reel/play/second.mp4?s=two']);
  });

  it('asks by the tmdb id, colon unencoded, and names the imdb id beside it', async () => {
    let asked = '';
    const record: typeof fetch = async (url) => {
      asked = String(url);
      return new Response(JSON.stringify({ meta: { links: [] } }), { status: 200 });
    };

    await trailerURLs('/reel/cfg', 'movie', { tmdb: 157336, imdb: 'tt0816692' }, ROUTES, {
      fetchImpl: record,
      secure: true,
    });
    // NOT `tmdb%3A157336`: reel matches the prefix against the raw path, so an encoded colon would
    // simply never be recognised and every one of these would quietly resolve the long way round.
    expect(asked).toBe('/reel/cfg/meta/movie/tmdb:157336.json?imdb=tt0816692');

    // Only an imdb id: asked for as it always was, with nothing to name alongside it.
    await trailerURLs('/reel/cfg', 'movie', { imdb: 'tt0816692' }, ROUTES, {
      fetchImpl: record,
      secure: true,
    });
    expect(asked).toBe('/reel/cfg/meta/movie/tt0816692.json');
  });
});
