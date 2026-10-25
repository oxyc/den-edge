import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPlayback, type PlaybackWant } from './playback';

const want: PlaybackWant = {
  imdb: 'tt0111161',
  audio: ['en'],
  subtitleLanguages: [],
  videoCodecs: ['h264'],
  player: 'hls.js',
};

const release = { label: '1080p', filename: 'film.mkv', size: 123 };
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  vi.stubGlobal('location', { href: 'https://den.example/movie/1' });
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('startPlayback', () => {
  it('keeps indexed TorBox built-ins as reload-free sidecars with a burn-in fallback', async () => {
    const token = 'a'.repeat(43);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:indexed-built-in');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/_sidecar/'))
        return new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
      if (url.endsWith('/cast-subtitle')) return new Response(null, { status: 503 });
      return json({
        url: 'https://flux-002.wnam.tb-cdn.io/opaque/index.m3u8',
        release,
        torboxSubtitle: null,
        subtitles: [
          {
            value: 'torbox-sidecar:1',
            language: 'eng',
            name: 'English',
            description: 'Built-in · SUBRIP',
            source: 'built-in',
            delivery: 'sidecar',
            url: `/den/_sidecar/${token}/1.vtt`,
            fallbackTorboxTrack: 1,
          },
          {
            value: 'torbox-sidecar:2',
            language: 'eng',
            name: 'English SDH',
            source: 'built-in',
            delivery: 'sidecar',
            url: `/den/~0123abcd/_sidecar/${token}/2.vtt`,
            fallbackTorboxTrack: 2,
          },
        ],
      });
    });

    const result = await startPlayback('/den/config/playback', want, fetchImpl);
    expect(result).toMatchObject({
      external: true,
      subtitles: [
        {
          value: 'torbox-sidecar:1',
          source: 'built-in',
          delivery: 'sidecar',
          fallbackTorboxTrack: 1,
        },
        {
          value: 'torbox-sidecar:2',
          source: 'built-in',
          delivery: 'sidecar',
          fallbackTorboxTrack: 2,
        },
      ],
    });
    expect(result && 'loadExternalSubtitle' in result).toBe(true);
    if (!result || 'failure' in result) throw new Error('expected a session');
    await expect(result.loadExternalSubtitle?.('torbox-sidecar:1')).resolves.toMatchObject({
      url: 'blob:indexed-built-in',
      language: 'eng',
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/_sidecar/'))).toBe(true);
    result.dispose?.();
  });

  it('returns external HLS without inventing a Remux lifecycle', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(
        {
          url: 'https://flux-002.wnam.tb-cdn.io/opaque/index.m3u8',
          release,
          audioTrack: 1,
          audioTracks: [
            { language: 'rus', name: null, channels: 0, commentary: false },
            { language: 'eng', name: null, channels: 0, commentary: false },
          ],
          torboxSubtitle: 4,
          subtitles: [
            {
              value: 'torbox:4',
              language: 'eng',
              name: 'English SDH',
              description: 'Built-in · SUBRIP',
              torboxTrack: 4,
            },
          ],
        },
        200,
        { 'server-timing': 'resolve;dur=12' },
      ),
    );
    const result = await startPlayback('/den/config/playback', want, fetchImpl);
    expect(result).toMatchObject({
      external: true,
      playlist: 'https://flux-002.wnam.tb-cdn.io/opaque/index.m3u8',
      subtitleResync: { supported: false, reason: 'managed_delivery' },
      release,
      duration: 0,
      audioTrack: 1,
      audioTracks: [
        { language: 'rus', channels: 0, commentary: false },
        { language: 'eng', channels: 0, commentary: false },
      ],
      torboxSubtitle: 4,
      subtitles: [
        {
          value: 'torbox:4',
          language: 'eng',
          name: 'English SDH',
          description: 'Built-in · SUBRIP',
          torboxTrack: 4,
        },
      ],
      startupTiming: 'resolve;dur=12',
    });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual(want);
    expect(new Headers(init.headers).get('idempotency-key')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(init.cache).toBe('no-store');
  });

  it('normalizes the existing Remux fields and explicit controls', async () => {
    const result = await startPlayback('/den/config/playback', want, async () =>
      json({
        url: '/remux/s/id/sig/master.m3u8',
        release,
        publicBase: 'https://media.example',
        lanBase: 'https://remux.home:8443',
        castOrigin: 'https://cast.example',
        hinted: true,
        session: {
          id: 'id',
          playlist: '/remux/s/id/sig/master.m3u8',
          duration: 7200,
          audioTrack: 0,
          audioTracks: [{ language: 'eng', channels: 6, commentary: false }],
          endUrl: '/remux/s/id/sig',
          heartbeatUrl: '/remux/s/id/sig/heartbeat',
          reportUrl: '/remux/s/id/sig/report',
          subtitleResync: { supported: true, url: '/remux/s/id/sig/subtitle-resync' },
          subtitles: [
            {
              language: 'en',
              name: 'English',
              source: 'opensubtitles',
              hashMatch: null,
              resyncSupported: true,
              rendition: 0,
            },
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      sid: 'id',
      playlist: 'https://den.example/remux/s/id/sig/master.m3u8',
      publicBase: 'https://media.example/',
      lanBase: 'https://remux.home:8443/',
      lanPlaylist: 'https://remux.home:8443/remux/s/id/sig/master.m3u8',
      castOrigin: 'https://cast.example',
      hinted: true,
      duration: 7200,
      subtitleResync: { supported: true, url: '/remux/s/id/sig/subtitle-resync' },
      subtitles: [
        {
          value: 'remux:opensubtitles:0:en',
          source: 'opensubtitles',
          hashMatch: false,
          resyncSupported: true,
          rendition: 0,
        },
      ],
      control: {
        end: 'https://den.example/remux/s/id/sig',
        heartbeat: 'https://den.example/remux/s/id/sig/heartbeat',
        report: 'https://den.example/remux/s/id/sig/report',
      },
    });
    expect(result).not.toHaveProperty('external');
  });

  it('keeps OpenSubtitles alternatives beside a Remux built-in rendition', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/subtitles/')
        ? json({
            subtitles: [
              {
                id: 'os-1',
                lang: 'en',
                release: 'Morning.Show.WEB-DL',
                downloads: 1200,
                url: '/den/config/subtitle/1.srt',
              },
            ],
          })
        : json({
            url: '/remux/s/id/sig/master.m3u8',
            release,
            session: {
              id: 'id',
              duration: 3600,
              audioTrack: 0,
              audioTracks: [],
              subtitles: [{ language: 'en', name: 'English (in file)' }],
            },
          }),
    );

    const result = await startPlayback(
      '/den/config/playback',
      { ...want, subtitleLanguages: ['en'] },
      fetchImpl,
    );

    expect(result).toMatchObject({
      subtitles: [
        {
          value: 'remux:built-in:0:en',
          language: 'en',
          name: 'English (in file)',
          source: 'built-in',
        },
        {
          value: 'opensubtitles:os-1',
          language: 'en',
          name: 'English',
          source: 'opensubtitles',
          description: expect.stringContaining('Morning.Show.WEB-DL'),
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reuses one key and byte-identical body after an ambiguous transport failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(
        json({ url: 'https://flux-002.wnam.tb-cdn.io/opaque/index.m3u8', release }),
      );
    expect(await startPlayback('/den/config/playback', want, fetchImpl)).toMatchObject({
      external: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const attempts = fetchImpl.mock.calls.map((call) => call[1]!);
    expect(attempts[0]!.body).toBe(attempts[1]!.body);
    expect(new Headers(attempts[0]!.headers).get('idempotency-key')).toBe(
      new Headers(attempts[1]!.headers).get('idempotency-key'),
    );
  });

  it('does not retry a completed HTTP refusal', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'playback_busy' }, 429, { 'retry-after': '3' }),
    );
    expect(await startPlayback('/den/config/playback', want, fetchImpl)).toEqual({
      failure: 'busy',
      code: 'playback_busy',
      httpStatus: 429,
      retryMs: 3_000,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('carries a replacement-pending retry delay to the player', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: 'replacement_pending' }, 409, { 'retry-after': '3' }),
    );
    expect(await startPlayback('/den/config/playback', want, fetchImpl)).toEqual({
      failure: 'starting',
      code: 'replacement_pending',
      httpStatus: 409,
      retryMs: 3_000,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('treats a concealed rollout route as legacy but a named missing release as final', async () => {
    expect(
      await startPlayback('/den/config/playback', want, async () =>
        json({ error: 'not_found' }, 404),
      ),
    ).toEqual({
      failure: 'legacy',
      code: 'unexpected_response',
      httpStatus: 404,
    });
    expect(
      await startPlayback('/den/config/playback', want, async () =>
        json({ error: 'no_release' }, 404),
      ),
    ).toEqual({ failure: 'none', code: 'no_release', httpStatus: 404 });
  });

  it('names the containers Remux left out when nothing else was ready', async () => {
    expect(
      await startPlayback('/den/config/playback', want, async () =>
        json({ error: 'no_release', formats: ['.ts', '.avi', '../x', 7] }, 404),
      ),
    ).toEqual({ failure: 'none', code: 'no_release', formats: ['.ts', '.avi'], httpStatus: 404 });
  });

  it('keeps Hearth source detail when its fallback also found no release', async () => {
    expect(
      await startPlayback('/den/config/playback', want, async () =>
        json({ error: 'no_release', cause: 'torbox_unsafe_stream_url' }, 404),
      ),
    ).toEqual({
      failure: 'sourceUnavailable',
      code: 'no_release',
      cause: 'torbox_unsafe_stream_url',
      httpStatus: 404,
    });
  });

  it.each([
    [400, 'bad_request', 'request'],
    [502, 'source_unavailable', 'sourceUnavailable'],
    [503, 'playback_unavailable', 'temporarilyUnavailable'],
    [504, 'playback_timeout', 'timedOut'],
  ] as const)('keeps the safe meaning of HTTP %s (%s)', async (status, code, failure) => {
    const result = await startPlayback('/den/config/playback', want, async () =>
      json({ error: code, detail: 'provider token must never be returned' }, status),
    );
    expect(result).toEqual({ failure, code, httpStatus: status });
    expect(JSON.stringify(result)).not.toContain('provider token');
  });

  it('honours Retry-After on temporary and timed-out answers without retrying HTTP itself', async () => {
    for (const [status, code] of [
      [503, 'playback_unavailable'],
      [504, 'playback_timeout'],
    ] as const) {
      const fetchImpl = vi.fn(async () => json({ error: code }, status, { 'retry-after': '7' }));
      await expect(startPlayback('/den/config/playback', want, fetchImpl)).resolves.toMatchObject({
        retryMs: 7_000,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it('never returns an arbitrary provider error or body detail', async () => {
    const result = await startPlayback('/den/config/playback', want, async () =>
      json(
        {
          error: 'torbox_key_dead_abc123',
          cause: 'torbox_secret_account_abc123',
          detail: 'secret account response',
        },
        502,
      ),
    );
    expect(result).toEqual({
      failure: 'sourceUnavailable',
      code: 'unexpected_response',
      httpStatus: 502,
    });
  });

  it.each([
    'managed_prepare_timeout',
    'torbox_authentication_failed',
    'torbox_item_not_found',
    'torbox_malformed_response',
    'torbox_managed_streaming_unavailable_for_plan',
    'torbox_playlist_unavailable',
    'torbox_rate_limited',
    'torbox_refused',
    'torbox_unavailable',
    'torbox_unreachable',
    'torbox_unsafe_stream_url',
  ] as const)('keeps only the documented managed cause %s', async (cause) => {
    const result = await startPlayback('/den/config/playback', want, async () =>
      json({ error: 'source_unavailable', cause, detail: 'private provider response' }, 502),
    );
    expect(result).toMatchObject({
      failure: 'sourceUnavailable',
      code: 'source_unavailable',
      cause,
      httpStatus: 502,
    });
    expect(JSON.stringify(result)).not.toContain('private provider response');
  });

  it.each([
    [{ error: 'debrid_down', service: 'torbox', reason: 'timeout' }, {}, 'debrid_down'],
    [
      { error: 'status_unavailable', service: 'torbox' },
      { 'x-den-degraded': 'debrid_slow' },
      'debrid_slow',
    ],
    [
      { error: 'store_unavailable', service: 'torbox' },
      { 'x-den-degraded': 'debrid_down' },
      'debrid_down',
    ],
  ] as const)(
    'a debrid answer %j waits out its Retry-After, carrying its code',
    async (body, headers, cause) => {
      const result = await startPlayback('/den/config/playback', want, async () =>
        json(body, 503, { 'retry-after': '7', ...headers }),
      );
      expect(result).toMatchObject({
        failure: 'temporarilyUnavailable',
        cause,
        httpStatus: 503,
        retryMs: 7_000,
      });
    },
  );

  it('honours a TorBox rate-limit wait attached to a final source failure', async () => {
    await expect(
      startPlayback('/den/config/playback', want, async () =>
        json({ error: 'source_unavailable', cause: 'torbox_rate_limited' }, 502, {
          'retry-after': '11',
        }),
      ),
    ).resolves.toEqual({
      failure: 'sourceUnavailable',
      code: 'source_unavailable',
      cause: 'torbox_rate_limited',
      httpStatus: 502,
      retryMs: 11_000,
    });
  });

  it('reports a repeatably malformed success as a protocol failure with one idempotent replay', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ url: 'not a usable answer' }));
    await expect(startPlayback('/den/config/playback', want, fetchImpl)).resolves.toEqual({
      failure: 'protocol',
      code: 'unexpected_response',
      httpStatus: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const keys = fetchImpl.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get('idempotency-key'),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('does not replay an operation the caller cancelled', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      controller.abort();
      throw init?.signal?.reason ?? new DOMException('cancelled', 'AbortError');
    });
    await expect(
      startPlayback('/den/config/playback', want, fetchImpl, controller.signal),
    ).resolves.toEqual({ failure: 'unreachable' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
