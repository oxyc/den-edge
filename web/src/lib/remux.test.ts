import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeRelease,
  endSession,
  findRemux,
  forgetBrowserTokens,
  forgetSubtitles,
  listReleases,
  login,
  releaseParts,
  reportFailure,
  REMUX_PROBE_TIMEOUT_MS,
  startSession,
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

describe('startSession', () => {
  beforeEach(forgetSubtitles);

  it('remembers which addon is den-subtitles, so the next session offers only that one', async () => {
    const offered: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      offered.push(body.subtitles);
      return body.subtitles === want.subtitles[1] ? answer(201, session) : answer(400, { error: 'bad_subtitles' });
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
      return body.subtitles === want.subtitles[1] ? answer(201, session) : answer(400, { error: 'bad_subtitles' });
    });
    expect(result).toEqual(session);
    expect(sent.map((b) => b.subtitles)).toEqual(want.subtitles);
    expect(sent[1]).toMatchObject({ imdb: 'tt0111161', scout: want.scout, audio: ['en-US'], videoCodecs: ['h264'], subtitleLanguages: ['en'] });
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

  it('asks for another track of the same release', async () => {
    let sent: Record<string, unknown> = {};
    await startSession({ ...want, subtitleLanguages: [], audioTrack: 1, filename: 'f.mkv' }, async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return answer(201, session);
    });
    expect(sent).toMatchObject({ audioTrack: 1, filename: 'f.mkv' });
  });

  it('says why a session could not start', async () => {
    const plain = { ...want, subtitleLanguages: [] };
    const failing = (status: number, error: string) => startSession(plain, async () => answer(status, { error }));
    expect(await failing(401, 'not_logged_in')).toEqual({ failure: 'login' });
    expect(await failing(404, 'no_playable_release')).toEqual({ failure: 'none' });
    expect(await failing(429, 'too_many_sessions')).toEqual({ failure: 'busy' });
    expect(await failing(503, 'transcode_unavailable')).toEqual({ failure: 'transcode' });
    expect(await failing(502, 'scout_unavailable')).toEqual({ failure: 'unreachable' });
    expect(await startSession(plain, async () => Promise.reject(new TypeError('offline')))).toEqual({ failure: 'unreachable' });
  });
});

describe('findRemux', () => {
  const lan = 'http://192.168.86.193:8095/remux';
  const tailnet = 'https://pve.example:8443/remux';
  const entries = [{ url: lan }, { url: tailnet }, { url: 'https://d-remux.example/remux', access: true }];
  const answering = (urls: string[]): typeof fetch => async (input) => {
    if (!urls.includes(String(input))) throw new TypeError('unreachable');
    return new Response('{"status":"ok"}', { status: 200 });
  };

  it('takes the first entry this page can use whose health answers', async () => {
    expect(await findRemux(entries, answering([`${lan}/health`, `${tailnet}/health`]), true), 'no http from https').toBe(tailnet);
    expect(await findRemux(entries, answering([`${lan}/health`]), false), 'an http page may use the LAN').toBe(lan);
    expect(await findRemux(entries, answering(['https://d-remux.example/remux/health']), true), 'no Access token').toBeNull();
    const shell: typeof fetch = async () => new Response('<!doctype html>', { status: 200 });
    expect(await findRemux(entries, shell, true), 'the app shell is not den-remux').toBeNull();
  });

  it('starts a session there and hands back a playlist this page can play', async () => {
    let asked = '';
    const result = await startSession({ ...want, subtitleLanguages: [] }, async (input) => {
      asked = String(input);
      return answer(201, session);
    }, tailnet);
    expect(asked).toBe(`${tailnet}/session`);
    expect(result).toMatchObject({ playlist: 'https://pve.example:8443/remux/s/sid/sig/master.m3u8' });
  });

  it('abandons a stalled route and tries the next, even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    try {
      let firstSignal: AbortSignal | undefined;
      const resolving = findRemux([{ url: tailnet }, { url: 'https://other.example/remux' }], async (url, init) => {
        if (String(url).startsWith(tailnet)) {
          firstSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        }
        return answer(200, { status: 'ok' });
      });
      await vi.advanceTimersByTimeAsync(REMUX_PROBE_TIMEOUT_MS);
      expect(await resolving).toBe('https://other.example/remux');
      expect(firstSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('applies the deadline to an unfinished JSON body too', async () => {
    vi.useFakeTimers();
    let close: (() => void) | undefined;
    try {
      const body = new ReadableStream({ start(controller) { close = () => controller.close(); } });
      const resolving = findRemux([{ url: tailnet }], async () => new Response(body));
      await vi.advanceTimersByTimeAsync(REMUX_PROBE_TIMEOUT_MS);
      expect(await resolving).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { close?.(); vi.useRealTimers(); }
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
    expect(await login('browser-key', async (_url, init) => {
      loginHeaders = new Headers(init?.headers);
      expect(JSON.parse(String(init?.body))).toEqual({ key: 'browser-key' });
      return new Response(null, { status: 204, headers: { 'x-den-browser-token': 'signed-browser-token' } });
    }, base)).toBe(true);
    expect(loginHeaders?.has('authorization')).toBe(false);
    const capture: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      capture.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
      expect(init?.credentials).not.toBe('include');
      expect(String(init?.body)).not.toContain('browser-key');
      return String(url).endsWith('/session') ? answer(201, session) : answer(200, { releases: [] });
    };
    await startSession({ ...want, subtitleLanguages: [] }, fetchImpl, base);
    await listReleases(want, fetchImpl, base);
    await startSession({ ...want, subtitleLanguages: [] }, fetchImpl, 'https://elsewhere.example/remux');
    expect(capture.map((r) => r.authorization)).toEqual(['Bearer signed-browser-token', 'Bearer signed-browser-token', null]);
  });

  it('forgets a rejected token so the next login or legacy cookie can authorize again', async () => {
    await login('k', async () => new Response(null, { status: 204, headers: { 'x-den-browser-token': 'expired' } }));
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
    expect(describeRelease(converted)).toBe('4K • REMUX • Dolby Vision · converted here to 800p H.264 SDR');
    expect(describeRelease({ ...converted, video: { codec: 'h264', transcoded: true, height: 1080 } })).toBe(
      '4K • REMUX • Dolby Vision · converted here to 1080p H.264',
    );
    expect(describeRelease({ ...session, video: { codec: 'hevc', transcoded: false } })).toBe('1080p');
  });

  it('gives the parts apart, so the player can lead with what plays', () => {
    expect(releaseParts(session)).toEqual({ release: '1080p' });
    const converted = { ...session, video: { codec: 'h264', transcoded: true, height: 1080, tonemapped: true } };
    expect(releaseParts(converted)).toEqual({ converted: '1080p H.264 SDR', release: '1080p' });
  });
});

describe('listReleases', () => {
  it('asks den-remux for the title’s releases and keeps the well-formed ones', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const releases = { releases: [{ label: '1080p • WEB-DL', filename: 'a.mkv', size: 1 }, { label: 'no name' }] };
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
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ imdb: 'tt0903624', scout: want.scout });
    expect(await listReleases({ imdb: 'tt1', scout: want.scout }, async () => answer(502, {}))).toBeNull();
  });
});

describe('reportFailure', () => {
  it('posts the browser’s error to the session’s report path, cut short', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    reportFailure(session, 4, `MEDIA_ERR_SRC_NOT_SUPPORTED ${'x'.repeat(300)}`, async (input, init) => {
      calls.push([String(input), init]);
      return new Response(null, { status: 204 });
    });
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([['/remux/s/sid/sig/report', 'POST']]);
    const body = JSON.parse(String(calls[0]![1]!.body)) as { code: number; message: string };
    expect([body.code, body.message.length, body.message.startsWith('MEDIA_ERR_SRC')]).toEqual([4, 200, true]);
  });
});
