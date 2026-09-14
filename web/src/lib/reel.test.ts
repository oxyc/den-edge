import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetWarmedTrailers,
  hlsURL,
  isPlaylist,
  nativeHls,
  trailerURL,
  trailerURLs,
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

// A press resolves a title's trailer and the page it opens reads that answer back; every test here
// asks about the same title and means it each time.
beforeEach(forgetWarmedTrailers);

describe('what a press resolved', () => {
  const ask = (fetchImpl: typeof fetch) =>
    trailerURLs('/reel/cfg', 'movie', { imdb: 'tt0111161' }, ROUTES, { fetchImpl, secure: true });

  it('is served to the page that press opened, without asking again', async () => {
    const asked: string[] = [];
    const counting: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify(meta), { status: 200 });
    };
    const pressed = await ask(counting);
    expect(await ask(counting), 'the page gets what the press found').toEqual(pressed);
    expect(asked, 'and reel is asked once, not twice').toHaveLength(1);
  });

  /** Usually reel saying "not yet" — a resolve still running — and pinning that would cost the trailer. */
  it('is not remembered when it found nothing', async () => {
    const nothing: typeof fetch = async () =>
      new Response(JSON.stringify({ meta: { links: [] } }), { status: 200 });
    expect(await ask(nothing)).toEqual([]);
    expect(await ask(answering(meta))).toHaveLength(2);
  });
});

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

describe('hlsURL', () => {
  it('is the play URL’s HLS sibling, signature and all', () => {
    expect(hlsURL('/reel/play/abc12345678.mp4?s=tag')).toBe('/reel/hls/abc12345678.m3u8?s=tag');
    expect(hlsURL('https://pve.example:8443/reel/play/abc12345678.mp4?s=tag&i=iid')).toBe(
      'https://pve.example:8443/reel/hls/abc12345678.m3u8?s=tag&i=iid',
    );
    expect(hlsURL('https://pve.example:8443/reel/crop/abc12345678.json')).toBeNull();
  });

  /** What a bare element is given: reel reorders the master, Google still serves every segment. */
  it('asks for the native master where the element plays the playlist itself', () => {
    expect(hlsURL('/reel/play/abc12345678.mp4?s=tag', true)).toBe(
      '/reel/hls/abc12345678.m3u8?s=tag&native=1',
    );
    // An unsigned deployment has no query to extend, so the flag opens one.
    expect(hlsURL('/reel/play/abc12345678.mp4', true)).toBe('/reel/hls/abc12345678.m3u8?native=1');
  });
});

describe('isPlaylist', () => {
  /** The bug it replaced: every signed HLS URL was called not-a-playlist, so hls.js never ran. */
  it('reads the path, not the query', () => {
    expect(isPlaylist('/reel/hls/abc12345678.m3u8?s=tag&native=1')).toBe(true);
    expect(isPlaylist('/reel/hls/abc12345678.m3u8')).toBe(true);
    expect(isPlaylist('/reel/play/abc12345678.mp4?s=tag')).toBe(false);
  });
});

describe('nativeHls', () => {
  const webkit = { claims: () => 'maybe', apple: true, mse: false };

  it('believes Apple’s WebKit, and a browser with no other way to play it', () => {
    expect(nativeHls(webkit)).toBe(true);
    // iPadOS carries MediaSource as well, and its own player is still the right one there.
    expect(nativeHls({ ...webkit, mse: true })).toBe(true);
    // Not Apple, but nothing to drive hls.js with either: a bare element is the only player here.
    expect(nativeHls({ ...webkit, apple: false })).toBe(true);
  });

  /**
   * Chrome 151 answers "maybe" and then stalls: it fetches the playlists and never asks for a
   * segment, so the trailer sits at readyState 0 with no error to fall back from. hls.js instead.
   */
  it('does not believe a Chromium that claims it', () => {
    expect(nativeHls({ claims: () => 'maybe', apple: false, mse: true })).toBe(false);
  });

  it('refuses a browser that claims nothing, and never throws', () => {
    expect(nativeHls({ ...webkit, claims: () => '' })).toBe(false);
    expect(
      nativeHls({
        ...webkit,
        claims: () => {
          throw new Error('no video element here');
        },
      }),
    ).toBe(false);
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
