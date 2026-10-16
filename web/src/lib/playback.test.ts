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
  it('returns external HLS without inventing a Remux lifecycle', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({ url: 'https://flux-002.wnam.tb-cdn.io/opaque/index.m3u8', release }, 200, {
        'server-timing': 'resolve;dur=12',
      }),
    );
    const result = await startPlayback('/den/config/playback', want, fetchImpl);
    expect(result).toMatchObject({
      external: true,
      playlist: 'https://flux-002.wnam.tb-cdn.io/opaque/index.m3u8',
      release,
      duration: 0,
      audioTracks: [],
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
        session: {
          id: 'id',
          duration: 7200,
          audioTrack: 0,
          audioTracks: [{ language: 'eng', channels: 6, commentary: false }],
          endUrl: '/remux/s/id/sig',
          heartbeatUrl: '/remux/s/id/sig/heartbeat',
          reportUrl: '/remux/s/id/sig/report',
        },
      }),
    );
    expect(result).toMatchObject({
      sid: 'id',
      playlist: 'https://den.example/remux/s/id/sig/master.m3u8',
      duration: 7200,
      control: {
        end: 'https://den.example/remux/s/id/sig',
        heartbeat: 'https://den.example/remux/s/id/sig/heartbeat',
        report: 'https://den.example/remux/s/id/sig/report',
      },
    });
    expect(result).not.toHaveProperty('external');
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
      retryMs: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('treats a concealed rollout route as legacy but a named missing release as final', async () => {
    expect(
      await startPlayback('/den/config/playback', want, async () =>
        json({ error: 'not_found' }, 404),
      ),
    ).toEqual({ failure: 'legacy' });
    expect(
      await startPlayback('/den/config/playback', want, async () =>
        json({ error: 'no_release' }, 404),
      ),
    ).toEqual({ failure: 'none' });
  });
});
