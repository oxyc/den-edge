import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeRelease,
  downmixLabel,
  endSession,
  findRemux,
  forgetBrowserTokens,
  forgetLinks,
  forgetSubtitles,
  linkLimit,
  LINK_TTL_MS,
  listReleases,
  localNetworkRefused,
  login,
  nativeHls,
  onLan,
  releaseParts,
  reportFailure,
  REMUX_PROBE_TIMEOUT_MS,
  SPEED_PROBE_BYTES,
  startSession,
  wantedLanguages,
  type Want,
} from './remux';

const want: Want = {
  imdb: 'tt0111161',
  scout: 'http://192.168.86.193:8080/sealed-cfg',
  subtitles: ['http://192.168.86.193:8092/reel-cfg', 'http://192.168.86.193:8093/subs-cfg'],
  subtitleLanguages: ['en'],
  audio: ['en-US'],
  videoCodecs: ['h264'],
};
const session = {
  playlist: '/remux/s/sid/sig/master.m3u8',
  duration: 7200,
  release: { label: '1080p', filename: 'f.mkv', size: 1 },
  audioTrack: 0,
  audioTracks: [{ language: 'eng', name: null, channels: 6, commentary: false }],
};
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(forgetBrowserTokens);

describe('wantedLanguages', () => {
  it('asks for the audio setting first, then the browser’s languages', () => {
    expect(wantedLanguages({ audio: 'fi' }, 'en', ['sv-FI', 'en-US', 'fi'])).toEqual({
      audio: ['fi', 'sv', 'en'],
      subtitleLanguages: [],
    });
  });

  it('asks for the title’s own language when the setting is Original', () => {
    expect(wantedLanguages({ subtitle: 'en' }, 'ko', ['en-GB'])).toEqual({
      audio: ['ko', 'en'],
      subtitleLanguages: ['en'],
    });
  });

  it('falls back to the browser’s languages when the title’s is unknown', () => {
    expect(wantedLanguages({}, undefined, ['de-DE', 'de'])).toEqual({
      audio: ['de'],
      subtitleLanguages: [],
    });
  });
});

describe('startSession', () => {
  beforeEach(forgetSubtitles);

  it('remembers which addon is den-subtitles, so the next session offers only that one', async () => {
    const offered: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      offered.push(body.subtitles);
      return body.subtitles === want.subtitles[1]
        ? answer(201, session)
        : answer(400, { error: 'bad_subtitles' });
    };
    await startSession(want, fetchImpl);
    offered.length = 0;
    await startSession(want, fetchImpl);
    expect(offered).toEqual([want.subtitles[1]]);
  });

  it('tries each LAN addon as den-subtitles until one is, and sends what the page wants', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(want, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return body.subtitles === want.subtitles[1]
        ? answer(201, session)
        : answer(400, { error: 'bad_subtitles' });
    });
    expect(result).toEqual(session);
    expect(sent.map((b) => b.subtitles)).toEqual(want.subtitles);
    expect(sent[1]).toMatchObject({
      imdb: 'tt0111161',
      scout: want.scout,
      audio: ['en-US'],
      videoCodecs: ['h264'],
      subtitleLanguages: ['en'],
    });
  });

  it('plays without subtitles when no addon is den-subtitles', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(want, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return body.subtitles ? answer(400, { error: 'bad_subtitles' }) : answer(201, session);
    });
    expect(result).toEqual(session);
    expect(sent.at(-1)).not.toHaveProperty('subtitles');
    expect(sent.at(-1)).not.toHaveProperty('subtitleLanguages');
  });

  it('asks for another track of the same release, from the second it was at', async () => {
    let sent: Record<string, unknown> = {};
    await startSession(
      {
        ...want,
        subtitleLanguages: [],
        audioTrack: 1,
        filename: 'f.mkv',
        startAt: 1234.5,
        maxBitrate: 7_000_000,
      },
      async (_input, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return answer(201, session);
      },
    );
    expect(sent).toMatchObject({
      audioTrack: 1,
      filename: 'f.mkv',
      startAt: 1234.5,
      maxBitrate: 7_000_000,
    });
  });

  it('says why a session could not start', async () => {
    const plain = { ...want, subtitleLanguages: [] };
    const failing = (status: number, error: string) =>
      startSession(plain, async () => answer(status, { error }));
    expect(await failing(401, 'not_logged_in')).toEqual({ failure: 'login' });
    expect(await failing(404, 'no_playable_release')).toEqual({ failure: 'none' });
    expect(await failing(429, 'too_many_sessions')).toEqual({ failure: 'busy' });
    expect(await failing(503, 'transcode_unavailable')).toEqual({ failure: 'transcode' });
    expect(await failing(502, 'scout_unavailable')).toEqual({ failure: 'unreachable' });
    expect(await startSession(plain, async () => Promise.reject(new TypeError('offline')))).toEqual(
      { failure: 'unreachable' },
    );
  });

  /** A GPU converting something else can mean minutes; knocking every twenty seconds is work it doesn't need. */
  it('carries the wait den-remux named, and leaves the caller its own when it named none', async () => {
    const plain = { ...want, subtitleLanguages: [] };
    const busy = (headers?: HeadersInit) =>
      startSession(
        plain,
        async () =>
          new Response(JSON.stringify({ error: 'too_many_sessions' }), { status: 429, headers }),
      );
    expect(await busy({ 'retry-after': '90' })).toEqual({ failure: 'busy', retryMs: 90_000 });
    expect(await busy()).toEqual({ failure: 'busy' });
  });
});

describe('localNetworkRefused', () => {
  const withPermissions = (query: unknown) => {
    const navigator = globalThis.navigator as unknown as { permissions?: unknown };
    const had = navigator.permissions;
    navigator.permissions = query;
    return () => {
      navigator.permissions = had;
    };
  };

  it('reports only a refusal, and nothing where the browser has no such permission', async () => {
    const asked: unknown[] = [];
    let restore = withPermissions({
      query: async (descriptor: unknown) => {
        asked.push(descriptor);
        return { state: 'denied' };
      },
    });
    expect(await localNetworkRefused()).toBe(true);
    expect(asked).toEqual([{ name: 'local-network-access' }]);
    restore();

    restore = withPermissions({ query: async () => ({ state: 'prompt' }) });
    expect(await localNetworkRefused(), 'unanswered is not a refusal').toBe(false);
    restore();

    restore = withPermissions({
      query: async () => {
        throw new TypeError('unknown permission name');
      },
    });
    expect(await localNetworkRefused(), 'a browser without the policy').toBe(false);
    restore();

    restore = withPermissions(undefined);
    expect(await localNetworkRefused()).toBe(false);
    restore();
  });
});

describe('findRemux', () => {
  const lan = 'http://192.168.86.193:8095/remux';
  const tailnet = 'https://pve.example:8443/remux';
  const entries = [
    { url: lan },
    { url: tailnet },
    { url: 'https://d-remux.example/remux', access: true },
  ];
  const answering =
    (urls: string[]): typeof fetch =>
    async (input) => {
      if (!urls.includes(String(input))) throw new TypeError('unreachable');
      return new Response('{"status":"ok"}', { status: 200 });
    };

  it('takes the first entry this page can use whose health answers', async () => {
    expect(
      await findRemux(entries, answering([`${lan}/health`, `${tailnet}/health`]), true),
      'no http from https',
    ).toBe(tailnet);
    expect(
      await findRemux(entries, answering([`${lan}/health`]), false),
      'an http page may use the LAN',
    ).toBe(lan);
    expect(
      await findRemux(entries, answering(['https://d-remux.example/remux/health']), true),
      'no Access token',
    ).toBeNull();
    const shell: typeof fetch = async () => new Response('<!doctype html>', { status: 200 });
    expect(await findRemux(entries, shell, true), 'the app shell is not den-remux').toBeNull();
  });

  it('starts a session there and hands back a playlist this page can play', async () => {
    let asked = '';
    const result = await startSession(
      { ...want, subtitleLanguages: [] },
      async (input) => {
        asked = String(input);
        return answer(201, session);
      },
      tailnet,
    );
    expect(asked).toBe(`${tailnet}/session`);
    expect(result).toMatchObject({
      playlist: 'https://pve.example:8443/remux/s/sid/sig/master.m3u8',
    });
  });

  it('abandons a stalled route and tries the next, even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    try {
      let firstSignal: AbortSignal | undefined;
      const resolving = findRemux(
        [{ url: tailnet }, { url: 'https://other.example/remux' }],
        async (url, init) => {
          if (String(url).startsWith(tailnet)) {
            firstSignal = init?.signal ?? undefined;
            return new Promise<Response>(() => {});
          }
          return answer(200, { status: 'ok' });
        },
      );
      await vi.advanceTimersByTimeAsync(REMUX_PROBE_TIMEOUT_MS);
      expect(await resolving).toBe('https://other.example/remux');
      expect(firstSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the deadline to an unfinished JSON body too', async () => {
    vi.useFakeTimers();
    let close: (() => void) | undefined;
    try {
      const body = new ReadableStream({
        start(controller) {
          close = () => controller.close();
        },
      });
      const resolving = findRemux([{ url: tailnet }], async () => new Response(body));
      await vi.advanceTimersByTimeAsync(REMUX_PROBE_TIMEOUT_MS);
      expect(await resolving).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      close?.();
      vi.useRealTimers();
    }
  });
});

describe('linkLimit', () => {
  const tailnet = 'https://pve.example.ts.net:8443/remux';
  beforeEach(forgetLinks);

  /**
   * den-remux's `/speed` as a link delivers it: each chunk arriving at its time on `clock`. A chunk is made only when
   * it is read (no queue ahead of the reader), and the body is handed over as it is rather than through a `Response`,
   * which reads ahead — either would move the clock before the chunk it belongs to is read.
   */
  const link = (arrivals: [ms: number, bytes: number][]) => {
    const clock = { now: 0 };
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(String(input));
      let next = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const arrival = arrivals[next++];
            if (!arrival) return controller.close();
            clock.now = arrival[0];
            controller.enqueue(new Uint8Array(arrival[1]));
          },
        },
        { highWaterMark: 0 },
      );
      return { ok: true, status: 200, body } as Response;
    };
    return { clock, asked, fetchImpl, now: () => clock.now };
  };

  it('asks for 70% of the link, timed past the first 150 ms after the first byte', async () => {
    // 100 KB inside the skipped start, then 1.25 MB over the next second: 10 Mbit/s.
    const measured = link([
      [1_000, 50_000],
      [1_100, 50_000],
      ...Array.from({ length: 10 }, (_, i): [number, number] => [1_200 + i * 100, 125_000]),
    ]);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now)).toBe(7_000_000);
    expect(measured.asked).toEqual([`${tailnet}/speed?bytes=${SPEED_PROBE_BYTES}`]);
  });

  it('measures once, and again once the link is ten minutes old', async () => {
    const measured = link([
      [0, 1],
      [1_000, 125_000],
    ]);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now)).toBe(700_000);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now)).toBe(700_000);
    expect(measured.asked).toHaveLength(1);
    measured.clock.now += LINK_TTL_MS;
    await linkLimit(tailnet, measured.fetchImpl, measured.now);
    expect(measured.asked).toHaveLength(2);
  });

  it('measures a link faster than the skipped start over the whole transfer', async () => {
    const measured = link([
      [0, 1_000_000],
      [100, 1_000_000],
    ]);
    // 2 MB in 100 ms: 160 Mbit/s.
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now)).toBe(112_000_000);
  });

  it('asks for nothing at home, or where the link can’t be timed', async () => {
    const measured = link([[0, 1]]);
    expect(await linkLimit('http://192.168.86.193:8095/remux', measured.fetchImpl)).toBeUndefined();
    expect(measured.asked, 'no probe on the LAN').toEqual([]);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now), 'one chunk').toBeUndefined();
    forgetLinks();
    const offline: typeof fetch = async () => Promise.reject(new TypeError('offline'));
    expect(await linkLimit(tailnet, offline)).toBeUndefined();
    forgetLinks();
    expect(await linkLimit(tailnet, async () => answer(429, {}))).toBeUndefined();
  });

  it('tells the home network from the tailnet and the internet', () => {
    expect(onLan('http://192.168.86.193:8095/remux')).toBe(true);
    expect(onLan('http://10.0.0.5:8095/remux')).toBe(true);
    expect(onLan('http://172.20.1.1/remux')).toBe(true);
    expect(onLan('http://172.32.0.1/remux')).toBe(false);
    expect(onLan('http://100.101.1.2:8095/remux'), 'a tailnet address').toBe(false);
    expect(onLan(tailnet)).toBe(false);
    expect(onLan('/remux', 'http://192.168.86.193:8094/'), 'its own origin, at home').toBe(true);
    expect(onLan('/remux', 'https://d.example/')).toBe(false);
  });
});

describe('login', () => {
  it('is true for a known key, false for an unknown one, and null out of reach', async () => {
    expect(await login('k', async () => new Response(null, { status: 204 }))).toBe(true);
    expect(await login('k', async () => answer(401, { error: 'bad_key' }))).toBe(false);
    expect(await login('k', async () => Promise.reject(new TypeError('offline')))).toBeNull();
  });

  it('uses the returned browser token for this remux only, without third-party cookies', async () => {
    const base = 'https://pve.example:8443/remux';
    let loginHeaders: Headers | undefined;
    expect(
      await login(
        'browser-key',
        async (_url, init) => {
          loginHeaders = new Headers(init?.headers);
          expect(JSON.parse(String(init?.body))).toEqual({ key: 'browser-key' });
          return new Response(null, {
            status: 204,
            headers: { 'x-den-browser-token': 'signed-browser-token' },
          });
        },
        base,
      ),
    ).toBe(true);
    expect(loginHeaders?.has('authorization')).toBe(false);
    const capture: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      capture.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      expect(init?.credentials).not.toBe('include');
      expect(String(init?.body)).not.toContain('browser-key');
      return String(url).endsWith('/session')
        ? answer(201, session)
        : answer(200, { releases: [] });
    };
    await startSession({ ...want, subtitleLanguages: [] }, fetchImpl, base);
    await listReleases(want, fetchImpl, base);
    await startSession(
      { ...want, subtitleLanguages: [] },
      fetchImpl,
      'https://elsewhere.example/remux',
    );
    expect(capture.map((r) => r.authorization)).toEqual([
      'Bearer signed-browser-token',
      'Bearer signed-browser-token',
      null,
    ]);
  });

  it('forgets a rejected token so the next login or legacy cookie can authorize again', async () => {
    await login(
      'k',
      async () =>
        new Response(null, { status: 204, headers: { 'x-den-browser-token': 'expired' } }),
    );
    const seen: (string | null)[] = [];
    const refused: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return answer(401, { error: 'not_logged_in' });
    };
    await startSession({ ...want, subtitleLanguages: [] }, refused);
    await startSession({ ...want, subtitleLanguages: [] }, refused);
    expect(seen).toEqual(['Bearer expired', null]);
  });
});

describe('endSession', () => {
  it('deletes the session by its signed path', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    endSession(session, async (input, init) => {
      calls.push([String(input), init]);
      return new Response(null, { status: 204 });
    });
    expect(calls).toEqual([['/remux/s/sid/sig', { method: 'DELETE', keepalive: true }]]);
  });
});

describe('describeRelease', () => {
  it('names what plays: the release, and what a conversion brought it down to', () => {
    expect(describeRelease(session)).toBe('1080p');
    const converted = {
      ...session,
      release: { ...session.release, label: '4K • REMUX • Dolby Vision' },
      video: { codec: 'h264', transcoded: true, width: 1920, height: 800, tonemapped: true },
    };
    expect(describeRelease(converted)).toBe(
      '4K • REMUX • Dolby Vision · converted here to 800p H.264 SDR',
    );
    expect(
      describeRelease({ ...converted, video: { codec: 'h264', transcoded: true, height: 1080 } }),
    ).toBe('4K • REMUX • Dolby Vision · converted here to 1080p H.264');
    expect(describeRelease({ ...session, video: { codec: 'hevc', transcoded: false } })).toBe(
      '1080p',
    );
  });

  it('gives the parts apart, so the player can lead with what plays', () => {
    expect(releaseParts(session)).toEqual({ release: '1080p' });
    const converted = {
      ...session,
      video: { codec: 'h264', transcoded: true, height: 1080, tonemapped: true },
    };
    expect(releaseParts(converted)).toEqual({ converted: '1080p H.264 SDR', release: '1080p' });
  });
});

describe('downmixLabel', () => {
  it('names what a session carries only where it has fewer channels than the track it plays', () => {
    const track = session.audioTracks[0]!;
    const surround = { ...session, audioTracks: [{ ...track, channels: 6 }] };
    expect(downmixLabel({ ...surround, audioChannels: 2 }), '5.1 played as stereo').toBe('Stereo');
    expect(downmixLabel({ ...surround, audioChannels: 6 })).toBeNull();
    const eight = { ...session, audioTracks: [{ ...track, channels: 8 }] };
    expect(downmixLabel({ ...eight, audioChannels: 6 }), '7.1 converted to 5.1 is not stereo').toBe(
      '5.1',
    );
    expect(downmixLabel(surround), 'a den-remux that doesn’t say').toBeNull();
    const mono = { ...session, audioTracks: [{ ...track, channels: 1 }] };
    expect(downmixLabel({ ...mono, audioChannels: 2 })).toBeNull();
    expect(
      downmixLabel({ ...surround, audioTrack: 3, audioChannels: 2 }),
      'no such track',
    ).toBeNull();
  });
});

describe('nativeHls', () => {
  const says = (answer: string) => ({ canPlayType: () => answer as CanPlayTypeResult });
  it('plays natively on Apple’s WebKit, where native HLS also brings AirPlay and picture-in-picture', () => {
    expect(nativeHls(says('maybe'), { vendor: 'Apple Computer, Inc.', mse: true })).toBe(true);
  });
  it('hands a browser with Media Source Extensions to hls.js even when it claims HLS itself (Chrome 151)', () => {
    expect(nativeHls(says('maybe'), { vendor: 'Google Inc.', mse: true })).toBe(false);
  });
  it('plays natively where there is no Media Source at all, and never where HLS is refused', () => {
    expect(nativeHls(says('probably'), { vendor: '', mse: false })).toBe(true);
    expect(nativeHls(says(''), { vendor: 'Apple Computer, Inc.', mse: false })).toBe(false);
  });
});

describe('listReleases', () => {
  it('asks den-remux for the title’s releases and keeps the well-formed ones', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const releases = {
      releases: [{ label: '1080p • WEB-DL', filename: 'a.mkv', size: 1 }, { label: 'no name' }],
    };
    const list = await listReleases(
      { imdb: 'tt0903624', scout: want.scout },
      async (input, init) => {
        calls.push([String(input), init]);
        return answer(200, releases);
      },
      'https://pve.example:8443/remux',
    );
    expect(list).toEqual([{ label: '1080p • WEB-DL', filename: 'a.mkv', size: 1 }]);
    expect(calls[0]![0]).toBe('https://pve.example:8443/remux/releases');
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      imdb: 'tt0903624',
      scout: want.scout,
    });
    expect(
      await listReleases({ imdb: 'tt1', scout: want.scout }, async () => answer(502, {})),
    ).toBeNull();
  });
});

describe('reportFailure', () => {
  it('posts the browser’s error to the session’s report path, cut short', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    reportFailure(
      session,
      4,
      `MEDIA_ERR_SRC_NOT_SUPPORTED ${'x'.repeat(300)}`,
      async (input, init) => {
        calls.push([String(input), init]);
        return new Response(null, { status: 204 });
      },
    );
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/remux/s/sid/sig/report', 'POST'],
    ]);
    const body = JSON.parse(String(calls[0]![1]!.body)) as { code: number; message: string };
    expect([body.code, body.message.length, body.message.startsWith('MEDIA_ERR_SRC')]).toEqual([
      4,
      200,
      true,
    ]);
  });
});
