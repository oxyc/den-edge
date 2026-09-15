import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetWarmedTrailers,
  cropStyle,
  directURL,
  fetchSources,
  hlsURL,
  progressiveURL,
  isPlaylist,
  nativeHls,
  trailerCandidates,
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

describe('trailerCandidates', () => {
  const ask = (fetchImpl: typeof fetch) =>
    trailerCandidates('/reel/cfg', 'movie', { imdb: 'tt0111161' }, ROUTES, {
      fetchImpl,
      secure: true,
    });

  it('carries reel’s sources URL onto this origin, beside the play URL', async () => {
    const named = {
      meta: {
        links: [
          {
            trailers: 'http://192.168.86.193:8092/play/abc123.mp4?s=tag&i=iid',
            sources: 'http://192.168.86.193:8092/sources/abc123.json?s=tag&i=iid',
          },
        ],
      },
    };
    // Both move to the relay's mount for the same reason: reel names them by the address it was asked
    // at, and its signature covers the video and the install rather than the host.
    expect(await ask(answering(named))).toEqual([
      {
        play: '/reel/play/abc123.mp4?s=tag&i=iid',
        sources: '/reel/sources/abc123.json?s=tag&i=iid',
      },
    ]);
  });

  /** A reel older than 0.29.0 names none, and the surface then derives what it plays from `play`. */
  it('is null where reel named no sources URL', async () => {
    const found = await ask(answering(meta));
    expect(found.map((one) => one.sources)).toEqual([null, null]);
    expect(found[0]?.play).toBe('/reel/play/abc123.mp4?s=tag&i=iid');
  });

  it('keeps the candidate when its sources URL is unusable', async () => {
    const bent = {
      meta: {
        links: [
          {
            trailers: 'http://192.168.86.193:8092/play/abc123.mp4?s=tag',
            // Not a URL this page would fetch, and not reel's shape: neither may cost us the trailer.
            sources: 'javascript:alert(1)',
          },
          {
            trailers: 'http://192.168.86.193:8092/play/def456.mp4?s=tag2',
            sources: 'http://192.168.86.193:8092/crop/def456.json?s=tag2',
          },
        ],
      },
    };
    expect((await ask(answering(bent))).map((one) => [one.play, one.sources])).toEqual([
      ['/reel/play/abc123.mp4?s=tag', null],
      ['/reel/play/def456.mp4?s=tag2', null],
    ]);
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

describe('directURL', () => {
  it('is the play URL’s direct sibling, signature and all', () => {
    expect(directURL('/reel/play/abc12345678.mp4?s=tag')).toBe(
      '/reel/direct/abc12345678.json?s=tag',
    );
    expect(directURL('https://pve.example:8443/reel/play/abc12345678.mp4?s=tag&i=iid')).toBe(
      'https://pve.example:8443/reel/direct/abc12345678.json?s=tag&i=iid',
    );
    expect(directURL('https://pve.example:8443/reel/crop/abc12345678.json')).toBeNull();
  });
});

describe('progressiveURL', () => {
  it('is the play URL’s progressive sibling, signature and all', () => {
    expect(progressiveURL('/reel/play/abc12345678.mp4?s=tag')).toBe(
      '/reel/progressive/abc12345678.mp4?s=tag',
    );
    expect(progressiveURL('https://pve.example:8443/reel/play/abc12345678.mp4?s=tag&i=iid')).toBe(
      'https://pve.example:8443/reel/progressive/abc12345678.mp4?s=tag&i=iid',
    );
    expect(progressiveURL('https://pve.example:8443/reel/crop/abc12345678.json')).toBeNull();
  });

  /** A rung small enough for a slide behind text, since these bytes cross the homelab. */
  it('asks for a height when one is wanted', () => {
    expect(progressiveURL('/reel/play/abc12345678.mp4?s=tag', 720)).toBe(
      '/reel/progressive/abc12345678.mp4?s=tag&height=720',
    );
    // An unsigned deployment has no query to extend, so the height opens one.
    expect(progressiveURL('/reel/play/abc12345678.mp4', 720)).toBe(
      '/reel/progressive/abc12345678.mp4?height=720',
    );
  });
});

describe('fetchSources', () => {
  const SOURCES = '/reel/cfg/sources/abc12345678.json?s=tag&i=iid';
  /** Captures what was asked, so the surface and player actually reaching reel can be asserted. */
  let asked = '';
  const answering = (body: unknown, status = 200): typeof fetch =>
    (async (input) => {
      asked = String(input);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  const two = {
    sources: [
      { kind: 'mp4', url: '/reel/m/s/blob1', audio: true, height: 1080 },
      { kind: 'hls', url: '/reel/m/n/blob2', audio: true, height: null },
    ],
  };

  it('names the surface and the player, and keeps reel’s order', async () => {
    const got = await fetchSources(SOURCES, {
      surface: 'audible',
      player: 'native',
      fetchImpl: answering(two),
    });
    expect(got?.sources.map((s) => s.kind)).toEqual(['mp4', 'hls']);
    expect(got?.sources[0]?.height).toBe(1080);
    expect(asked).toContain('surface=audible');
    expect(asked).toContain('player=native');
    // The signature it was given travels untouched; reel signs over the video and install, not the query.
    expect(asked).toContain('s=tag');
  });

  /** The relay forwards no `X-Den-Playable`, so the report has to ride in the query or never arrive. */
  it('sends the codec report in the query', async () => {
    await fetchSources(SOURCES, {
      surface: 'silent',
      player: 'hls.js',
      playable: { h264: 0x33, vp9: true },
      fetchImpl: answering(two),
    });
    expect(asked).toContain(`playable=${encodeURIComponent('{"h264":51,"vp9":true}')}`);
  });

  it('drops what it cannot play and never the same URL twice', async () => {
    const got = await fetchSources(SOURCES, {
      surface: 'silent',
      player: 'native',
      fetchImpl: answering({
        sources: [
          { kind: 'mp4', url: '/reel/m/s/blob1' },
          // A kind we don't know how to mount is worse than no entry: it would hand a bare element a
          // playlist, or hls.js a file.
          { kind: 'dash', url: '/reel/m/s/blob9' },
          { kind: 'hls', url: undefined },
          // A repeat would be a fallback step that changes nothing: no load, no error, ladder stalled.
          { kind: 'mp4', url: '/reel/m/s/blob1' },
        ],
      }),
    });
    expect(got?.sources).toEqual([
      { kind: 'mp4', url: '/reel/m/s/blob1', audio: false, height: null },
    ]);
  });

  it('answers null for a refusal or a shape it does not recognise', async () => {
    expect(
      await fetchSources(SOURCES, {
        surface: 'silent',
        player: 'native',
        fetchImpl: answering({}, 500),
      }),
    ).toBeNull();
    expect(
      await fetchSources(SOURCES, {
        surface: 'silent',
        player: 'native',
        fetchImpl: answering({ sources: [] }),
      }),
    ).toBeNull();
    expect(
      await fetchSources(SOURCES, {
        surface: 'silent',
        player: 'native',
        fetchImpl: answering({ ok: true }),
      }),
    ).toBeNull();
  });

  it('takes a measured crop and treats anything else as not yet measured', async () => {
    const measured = await fetchSources(SOURCES, {
      surface: 'silent',
      player: 'native',
      fetchImpl: answering({
        ...two,
        crop: { letterboxed: true, aspect: 1.85, rect: [0, 0.0194, 1, 0.9611] },
      }),
    });
    expect(measured?.crop).toEqual({
      letterboxed: true,
      aspect: 1.85,
      rect: [0, 0.0194, 1, 0.9611],
    });
    // Null on the first ask for a trailer reel has not measured yet — the expected case, not an error.
    const unmeasured = await fetchSources(SOURCES, {
      surface: 'silent',
      player: 'native',
      fetchImpl: answering({ ...two, crop: null }),
    });
    expect(unmeasured?.crop).toBeNull();
    expect(unmeasured?.sources.length).toBe(2);
  });
});

describe('cropStyle', () => {
  it('scales the content rect up to fill, about its own centre', () => {
    // reel's real answer for a 1.85 trailer in a 16:9 upload: bars top and bottom.
    expect(cropStyle({ letterboxed: true, aspect: 1.85, rect: [0, 0.0194, 1, 0.9611] })).toBe(
      'transform: scale(1.0405); transform-origin: 50.000% 49.995%;',
    );
  });

  it('does nothing where there is nothing to trim', () => {
    expect(cropStyle(null)).toBeNull();
    expect(cropStyle(undefined)).toBeNull();
    // Measured and found not letterboxed: draw it as it is.
    expect(cropStyle({ letterboxed: false, aspect: 1.78, rect: [0, 0, 1, 1] })).toBeNull();
    // Letterboxed but the rect is the whole frame: scaling by 1 would be a no-op transform on every frame.
    expect(cropStyle({ letterboxed: true, aspect: 1.78, rect: [0, 0, 1, 1] })).toBeNull();
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
