import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeRelease,
  downmixLabel,
  endSession,
  findRemux,
  forgetBrowserTokens,
  forgetLinks,
  forgetSubtitles,
  guestLimits,
  linkLimit,
  linkRate,
  LINK_MEMORY_MS,
  LINK_TTL_MS,
  premeasureLink,
  relayLimit,
  rememberedLink,
  rememberLink,
  listReleases,
  localNetworkRefused,
  login,
  nativeHls,
  onLan,
  releaseParts,
  reportFailure,
  sourceFailed,
  REMUX_PROBE_TIMEOUT_MS,
  SPEED_PROBE_BYTES,
  startSession,
  wantedLanguages,
  videoCodecsOf,
  type Want,
} from './remux';
import type { Playable } from './playable';

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
      // No preferred subtitle language is not the same as no subtitles: the browser's own languages are
      // still worth offering behind a picker. Asking for none is what left the player nothing to switch to.
      subtitleLanguages: ['sv', 'en', 'fi'],
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
      subtitleLanguages: ['de'],
    });
  });

  /**
   * The chosen language must come FIRST. den-remux marks the first rendition DEFAULT=YES, so whichever
   * language leads here is the one a player that honours the default would bring up.
   */
  it('leads with the chosen language, then Settings’ shown list, then the browser’s', () => {
    expect(
      wantedLanguages({ subtitle: 'fi', shownSubtitles: ['sv', 'en'] }, 'ko', ['en-GB', 'de'])
        .subtitleLanguages,
    ).toEqual(['fi', 'sv', 'en', 'de']);
  });

  /** den-remux builds at most four renditions for a session; asking for more buys nothing. */
  it('asks for no more languages than den-remux will build', () => {
    expect(
      wantedLanguages({ shownSubtitles: ['fi', 'sv', 'en', 'de', 'fr', 'es'] }, undefined, ['it'])
        .subtitleLanguages,
    ).toEqual(['fi', 'sv', 'en', 'de']);
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
    expect(await failing(410, 'grant_expired')).toEqual({ failure: 'ended' });
    expect(await failing(404, 'no_playable_release')).toEqual({ failure: 'none' });
    expect(await failing(429, 'too_many_sessions')).toEqual({ failure: 'busy' });
    expect(await failing(503, 'transcode_unavailable')).toEqual({ failure: 'transcode' });
    expect(await failing(404, 'no_copy')).toEqual({ failure: 'noCopy' });
    expect(await failing(404, 'no_fitting_copy')).toEqual({ failure: 'noFit' });
    expect(await failing(502, 'scout_unavailable')).toEqual({ failure: 'unreachable' });
    expect(await startSession(plain, async () => Promise.reject(new TypeError('offline')))).toEqual(
      { failure: 'unreachable' },
    );
  });

  it('reads a session it cannot parse as out of reach, rather than throwing', async () => {
    const plain = { ...want, subtitleLanguages: [] };
    const cutOff = async () => new Response('{"playlist":', { status: 201 });
    expect(await startSession(plain, cutOff)).toEqual({ failure: 'unreachable' });
  });

  it('gives den-remux a deadline for the session and the release list', async () => {
    const signals: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      signals.push(init?.signal);
      return answer(201, { ...session, releases: [] });
    };
    await startSession({ ...want, subtitleLanguages: [] }, fetchImpl);
    await listReleases({ imdb: 'tt1', scout: want.scout }, fetchImpl);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('says a guest’s revoked grant ended, and that a session has no public address for this network', async () => {
    vi.stubGlobal('location', { href: 'https://den.example/', origin: 'https://den.example' });
    try {
      const guest = {
        ...want,
        scout: 'https://den.example/scout/~a1b2c3d4',
        subtitleLanguages: [],
      };
      const failing = (wanted: Want, status: number, error: string) =>
        startSession(wanted, async () => answer(status, { error }));
      expect(await failing(guest, 404, 'not_found')).toEqual({ failure: 'ended' });
      expect(await failing(guest, 404, 'no_playable_release')).toEqual({ failure: 'none' });
      // Up front, and final: a guest's session is never converted, so no retry loop waits for a free GPU.
      expect(await failing(guest, 404, 'no_copy')).toEqual({ failure: 'noCopy' });
      expect(await failing(guest, 503, 'public_media_unavailable')).toEqual({ failure: 'public' });
      // The guest limits are known ones, and each says what to do instead.
      expect(await failing(guest, 503, 'public_media_ipv6')).toEqual({ failure: 'ipv6' });
      expect(await failing(guest, 503, 'public_media_cast')).toEqual({ failure: 'cast' });
      expect(guestLimits.ipv6).toBe(
        'Playing away from home needs an IPv4 connection for now. Try another network (a phone hotspot often works).',
      );
      expect(guestLimits.cast).toBe(
        'Casting isn’t available for invited guests yet — play it in this browser instead.',
      );
      // A library's own 404 is still a title with no release.
      expect(await failing({ ...want, subtitleLanguages: [] }, 404, 'not_found')).toEqual({
        failure: 'none',
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

  /** Past den-edge's cap on reported addresses is not "busy": waiting would meet the same cap again. */
  it('asks once more without the IPv4 hint when den-edge has seen too many', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(
      { ...want, subtitleLanguages: [], ipv4Hint: '198.51.100.7' },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        return body.ipv4Hint ? answer(429, { error: 'hint_limit' }) : answer(201, session);
      },
    );
    expect(sent.map(({ ipv4Hint, noHint }) => ({ ipv4Hint, noHint }))).toEqual([
      { ipv4Hint: '198.51.100.7', noHint: undefined },
      { ipv4Hint: undefined, noHint: true },
    ]);
    expect(result).toMatchObject({ playlist: session.playlist });
  });

  /** Most visitors reach den-edge over IPv4, where the hint is never used: they make no third-party request. */
  it('looks up no address when the first answer is a session', async () => {
    const lookup = vi.fn(async () => '198.51.100.7');
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(
      { ...want, subtitleLanguages: [] },
      async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return answer(201, session);
      },
      '/remux',
      lookup,
    );
    expect(result).toMatchObject({ playlist: session.playlist });
    expect(lookup).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('ipv4Hint');
    expect(sent[0]).not.toHaveProperty('noHint');
  });

  it('looks up the address when den-edge asks for it, and asks once more with it', async () => {
    const lookup = vi.fn(async () => '198.51.100.7');
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(
      { ...want, subtitleLanguages: [] },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        return body.ipv4Hint
          ? answer(201, { ...session, hinted: true })
          : answer(428, { error: 'ipv4_hint_wanted' });
      },
      '/remux',
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(sent.map(({ ipv4Hint, noHint }) => ({ ipv4Hint, noHint }))).toEqual([
      { ipv4Hint: undefined, noHint: undefined },
      { ipv4Hint: '198.51.100.7', noHint: undefined },
    ]);
    expect(result).toMatchObject({ playlist: session.playlist, hinted: true });
  });

  it('asks once more as a page with no address when the lookup finds none', async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await startSession(
      { ...want, subtitleLanguages: [] },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        // A guest over IPv6 with no address to give: refused as such, and not asked for one again.
        return body.noHint
          ? answer(503, { error: 'public_media_ipv6' })
          : answer(428, { error: 'ipv4_hint_wanted' });
      },
      '/remux',
      async () => undefined,
    );
    expect(sent.map(({ ipv4Hint, noHint }) => ({ ipv4Hint, noHint }))).toEqual([
      { ipv4Hint: undefined, noHint: undefined },
      { ipv4Hint: undefined, noHint: true },
    ]);
    expect(result).toEqual({ failure: 'ipv6' });
  });

  it('asks for the address at most once per start', async () => {
    const lookup = vi.fn(async () => '198.51.100.7');
    let asked = 0;
    const result = await startSession(
      { ...want, subtitleLanguages: [] },
      async () => {
        asked += 1;
        return answer(428, { error: 'ipv4_hint_wanted' });
      },
      '/remux',
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(asked).toBe(2);
    expect(result).toEqual({ failure: 'unreachable' });
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

  it('asks for 70% of the link, timed past the first megabyte, as much as den-remux sends', async () => {
    // The first MiB is passed by the 8th 125 KB chunk (1.9 s); after it, 250 KB in 200 ms: 10 Mbit/s.
    const measured = link([
      [1_000, 50_000],
      [1_100, 50_000],
      ...Array.from({ length: 10 }, (_, i): [number, number] => [1_200 + i * 100, 125_000]),
    ]);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now)).toBe(7_000_000);
    expect(measured.asked).toEqual([`${tailnet}/speed?bytes=${SPEED_PROBE_BYTES}`]);
    expect(SPEED_PROBE_BYTES, 'den-remux sends 8 MiB at most').toBe(8 * 1024 * 1024);
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

  it('measures a transfer too short to pass the skipped start over the whole of it', async () => {
    const measured = link([
      [0, 500_000],
      [100, 500_000],
    ]);
    // The second 500 KB in the 100 ms after the first arrived: 40 Mbit/s.
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now)).toBe(28_000_000);
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

  it('takes a remembered link without measuring, and remembers one it measured', async () => {
    const storage = memoryStorage();
    rememberLink(tailnet, 3_780_000, Date.now(), storage);
    const measured = link([
      [0, 1],
      [1_000, 125_000],
    ]);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now, storage)).toBe(3_780_000);
    expect(measured.asked, 'no probe for a remembered link').toEqual([]);

    const fresh = memoryStorage();
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now, fresh)).toBe(700_000);
    expect(rememberedLink(tailnet, Date.now(), fresh)?.maxBitrate).toBe(700_000);
  });

  it('measures as before where the browser refuses storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const measured = link([
      [0, 1],
      [1_000, 125_000],
    ]);
    expect(await linkLimit(tailnet, measured.fetchImpl, measured.now, refusing)).toBe(700_000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('linkRate', () => {
  /** Slow start on a 250 ms path: the window doubles each round trip from 16 KB until it is past 1 MB. */
  const slowStart: [number, number][] = [16, 32, 64, 128, 256, 512].map((kb, i) => [
    i * 250,
    kb * 1024,
  ]);

  it('passes over slow start on a long path and times the link after it', () => {
    // A 20 Mbit/s link: 625 KB a round trip once the window is open.
    const steady = Array.from({ length: 5 }, (_, i): [number, number] => [
      1_500 + i * 250,
      625_000,
    ]);
    expect(linkRate([...slowStart, ...steady])).toBe(20_000_000);
  });

  it('reads a burst as a burst, not as the link', () => {
    // 10 Mbit/s for ten seconds — 312.5 KB every 250 ms — with five chunks bunched up at 6 s: the best second of it
    // runs at 22.5 Mbit/s, which admission would then have trusted.
    const tail: [number, number][] = Array.from({ length: 41 }, (_, i): [number, number] => [
      1_500 + i * 250,
      312_500,
    ]);
    const burst = Array.from({ length: 5 }, (_, i): [number, number] => [6_010 + i * 10, 312_500]);
    const chunks = [...slowStart, ...tail, ...burst].sort((a, b) => a[0] - b[0]);
    expect(linkRate(chunks)).toBe(10_000_000);
  });

  it('is not dragged down by a pause in the tail', () => {
    const tail: [number, number][] = [
      ...Array.from({ length: 20 }, (_, i): [number, number] => [1_500 + i * 250, 312_500]),
      // Nothing for a second — another tab, the radio — then the link again.
      ...Array.from({ length: 20 }, (_, i): [number, number] => [7_500 + i * 250, 312_500]),
    ];
    expect(linkRate([...slowStart, ...tail])).toBe(10_000_000);
  });

  it('times a tail shorter than a window whole, and nothing from one chunk', () => {
    expect(linkRate([...slowStart, [1_500, 625_000], [1_750, 625_000]])).toBe(20_000_000);
    expect(linkRate([[0, 1]])).toBeNull();
    expect(linkRate([])).toBeNull();
    expect(
      linkRate([
        [5, 1],
        [5, 100],
      ]),
      'no time passed',
    ).toBeNull();
  });
});

/** Storage as a browser keeps it, in memory. */
function memoryStorage(): Storage {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
    clear: () => kept.clear(),
    key: (n: number) => [...kept.keys()][n] ?? null,
    get length() {
      return kept.size;
    },
  };
}

/** A private or blocked window's storage: every access throws. */
const refusing = {
  getItem() {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  },
  setItem() {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  },
} as unknown as Storage;

describe('rememberedLink', () => {
  const tailnet = 'https://pve.example.ts.net:8443/remux';

  it('keeps a route’s link for six hours, and only that route’s', () => {
    const storage = memoryStorage();
    rememberLink(tailnet, 3_780_000, 1_000, storage);
    expect(rememberedLink(tailnet, 1_000 + LINK_MEMORY_MS - 1, storage)).toEqual({
      at: 1_000,
      maxBitrate: 3_780_000,
    });
    expect(rememberedLink(tailnet, 1_000 + LINK_MEMORY_MS, storage)).toBeUndefined();
    expect(rememberedLink('/remux', 1_000, storage)).toBeUndefined();
  });

  it('remembers the home network as a link with no limit', () => {
    const storage = memoryStorage();
    rememberLink('/remux', undefined, 1_000, storage);
    expect(rememberedLink('/remux', 2_000, storage)).toEqual({ at: 1_000 });
  });

  it('starts a relayed session under a remembered link, so it is never measured inside and replaced', () => {
    const storage = memoryStorage();
    expect(relayLimit('/remux', undefined, storage), 'nothing known: measured inside').toBe(
      undefined,
    );
    rememberLink('/remux', 3_780_000, Date.now(), storage);
    expect(relayLimit('/remux', undefined, storage)).toBe(3_780_000);
    expect(relayLimit('/remux', 2_000_000, storage), 'this player’s own measure first').toBe(
      2_000_000,
    );
    rememberLink('/remux', undefined, Date.now(), storage);
    expect(relayLimit('/remux', undefined, storage), 'at home: no limit').toBeUndefined();
  });

  it('reads nothing, and throws nothing, where storage throws or holds something else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => rememberLink(tailnet, 1, 0, refusing)).not.toThrow();
    expect(rememberedLink(tailnet, 0, refusing)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    const storage = memoryStorage();
    storage.setItem(`den.remux.link:${tailnet}`, 'not json');
    expect(rememberedLink(tailnet, 0, storage)).toBeUndefined();
    warn.mockRestore();
  });
});

describe('premeasureLink', () => {
  beforeEach(forgetLinks);

  /** An idle callback run when the test says. */
  const idleness = () => {
    let pending: (() => void) | undefined;
    return {
      idle: (run: () => void) => {
        pending = run;
        return () => (pending = undefined);
      },
      run: () => pending?.(),
      get waiting() {
        return pending !== undefined;
      },
    };
  };
  const speed =
    (asked: string[]): typeof fetch =>
    async (input) => {
      asked.push(String(input));
      const chunks = [1, 125_000];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const size = chunks.shift();
          if (size === undefined) return controller.close();
          controller.enqueue(new Uint8Array(size));
        },
      });
      return { ok: true, status: 200, body } as Response;
    };

  it('times the relay’s link once the page is idle, and remembers it', async () => {
    const storage = memoryStorage();
    const asked: string[] = [];
    const idle = idleness();
    let clock = 0;
    premeasureLink('/remux', {
      fetchImpl: speed(asked),
      now: () => (clock += 500),
      storage,
      idle: idle.idle,
    });
    expect(asked, 'nothing before the page is idle').toEqual([]);
    idle.run();
    await vi.waitFor(() => expect(rememberedLink('/remux', Date.now(), storage)).toBeDefined());
    expect(asked).toEqual([`/remux/speed?bytes=${SPEED_PROBE_BYTES}`]);
    expect(rememberedLink('/remux', Date.now(), storage)?.maxBitrate).toBeGreaterThan(0);

    const again = idleness();
    premeasureLink('/remux', { fetchImpl: speed(asked), storage, idle: again.idle });
    expect(again.waiting, 'remembered: not timed again').toBe(false);
  });

  it('times a route once per page even when it could not be timed, and never at home', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStorage();
    const idle = idleness();
    let asked = 0;
    const refused: typeof fetch = async () => {
      asked += 1;
      return new Response(null, { status: 429 });
    };
    premeasureLink('/remux', { fetchImpl: refused, storage, idle: idle.idle });
    idle.run();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    const again = idleness();
    premeasureLink('/remux', { fetchImpl: refused, storage, idle: again.idle });
    expect(again.waiting).toBe(false);
    expect(asked).toBe(1);

    const home = idleness();
    premeasureLink('http://192.168.86.193:8095/remux', { storage, idle: home.idle });
    expect(home.waiting).toBe(false);
    warn.mockRestore();
  });

  it('gives up when Play is pressed, remembers nothing, and may time the route again later', async () => {
    const storage = memoryStorage();
    const idle = idleness();
    const cancel = premeasureLink('/remux', { storage, idle: idle.idle });
    cancel();
    expect(idle.waiting, 'not yet idle: never started').toBe(false);

    let aborted = false;
    const hanging: typeof fetch = async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_000));
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return { ok: true, status: 200, body } as Response;
    };
    const midway = idleness();
    const stop = premeasureLink('/remux', { fetchImpl: hanging, storage, idle: midway.idle });
    midway.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rememberedLink('/remux', Date.now(), storage)).toBeUndefined();

    const later = idleness();
    premeasureLink('/remux', { fetchImpl: hanging, storage, idle: later.idle });
    expect(later.waiting).toBe(true);
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

  it('leaves a session the cast page plays to that page, which alone may connect to its address', () => {
    const calls: string[] = [];
    const framed = {
      ...session,
      publicBase: 'https://media.test',
      castOrigin: 'https://cast.test',
    };
    endSession(framed, async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 204 });
    });
    expect(calls).toEqual([]);
    // A relay session with no cast page is still this page's to end.
    endSession({ ...session, publicBase: 'https://media.test' }, async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 204 });
    });
    expect(calls).toEqual(['/remux/s/sid/sig']);
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
    // A den-remux that gives no verdict is taken to play everything.
    expect(list).toEqual([{ label: '1080p • WEB-DL', filename: 'a.mkv', size: 1, plays: 'yes' }]);
    expect(calls[0]![0]).toBe('https://pve.example:8443/remux/releases');
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      imdb: 'tt0903624',
      scout: want.scout,
    });
    expect(
      await listReleases({ imdb: 'tt1', scout: want.scout }, async () => answer(502, {})),
    ).toBeNull();
  });

  it('sends the browser’s claims and reads each release’s verdict', async () => {
    const bodies: unknown[] = [];
    const claims = { videoCodecs: ['h264', 'hevc'], playable: { hevcMain: 153 } as Playable };
    const list = await listReleases(
      { imdb: 'tt1', scout: want.scout },
      async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return answer(200, {
          releases: [
            { label: 'a', filename: 'a.mkv', plays: 'no', why: 'Dolby Vision profile 5' },
            { label: 'b', filename: 'b.mkv', plays: 'convert' },
            { label: 'c', filename: 'c.mkv', plays: 'yes', why: '' },
            { label: 'd', filename: 'd.mkv', plays: 'maybe', why: 7 },
          ],
        });
      },
      '/remux',
      claims,
    );
    expect(bodies[0]).toEqual({ imdb: 'tt1', scout: want.scout, ...claims });
    expect(list).toEqual([
      { label: 'a', filename: 'a.mkv', plays: 'no', why: 'Dolby Vision profile 5' },
      { label: 'b', filename: 'b.mkv', plays: 'convert' },
      { label: 'c', filename: 'c.mkv', plays: 'yes' },
      { label: 'd', filename: 'd.mkv', plays: 'yes' },
    ]);
  });

  it('names h264 and, where it decodes it, hevc', () => {
    expect(videoCodecsOf({ hevcMain: 0, hevcMain10: 0 } as Playable)).toEqual(['h264']);
    expect(videoCodecsOf({ hevcMain: 0, hevcMain10: 153 } as Playable)).toEqual(['h264', 'hevc']);
  });
});

describe('sourceFailed', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n';
  const media =
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg0.m4s\n#EXTINF:6.0,\nseg1.m4s\n';

  const serving = (status: number, seen: string[] = []) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('master.m3u8')) return new Response(master);
      if (url.endsWith('media.m3u8')) return new Response(media);
      return new Response('', { status });
    }) as unknown as typeof fetch;

  it('asks for the segment being waited on, not the first one', async () => {
    const seen: string[] = [];
    expect(await sourceFailed(session, 7, serving(502, seen))).toBe(true);
    // 7 s is inside the SECOND segment. Asking for seg0 would start a fresh job at the beginning of the
    // film — a part of the stream nobody is watching, which answers 200 and proves nothing.
    expect(seen.at(-1)).toContain('seg1.m4s');
  });

  it('is no verdict when the segment is served', async () => {
    expect(await sourceFailed(session, 1, serving(200))).toBe(false);
  });

  it('is no verdict when it cannot ask at all', async () => {
    const offline = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await sourceFailed(session, 1, offline)).toBe(false);
  });

  it('is no verdict past the end of the playlist', async () => {
    expect(await sourceFailed(session, 9_999, serving(502))).toBe(false);
  });

  it('asks every request under a deadline, so a hung segment is no verdict rather than no answer', async () => {
    const signals: unknown[] = [];
    const inner = serving(502);
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return inner(input, init);
    }) as typeof fetch;
    await sourceFailed(session, 7, fetchImpl);
    expect(signals).toHaveLength(3);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
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

  it('sends nothing for a session the cast page plays: that page reports its own failures', () => {
    const calls: string[] = [];
    const framed = {
      ...session,
      publicBase: 'https://media.test',
      castOrigin: 'https://cast.test',
    };
    reportFailure(framed, 3, 'DECODE', async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 204 });
    });
    expect(calls).toEqual([]);
  });
});
