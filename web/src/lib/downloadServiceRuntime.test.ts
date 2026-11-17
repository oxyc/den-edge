import { describe, expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import type { DownloadContent } from './downloadServiceRuntime';
import { DownloadServiceRuntime } from './downloadServiceRuntime';
import { testLog } from './downloadTestLog';
import type { SettingsRow } from './wire';

const clock: ClockStore = {
  device: 'aaaaaaaaaaaaaaaa',
  issue: async () => [1, 0, 'aaaaaaaaaaaaaaaa'],
  see: async () => {},
  current: async () => [1, 0, 'aaaaaaaaaaaaaaaa'],
  historical: async (times) => times.map((at, index) => [at, index + 1, 'aaaaaaaaaaaaaaaa']),
};
const content = {
  identifiers: async () => ({ kind: 'missing' as const }),
  season: async () => ({ kind: 'missing' as const }),
} satisfies DownloadContent;

describe('DownloadServiceRuntime artwork', () => {
  it('keeps legacy Scout downloads active without scheduling absent Hearth retries', async () => {
    const install = 'http://192.168.1.5:8080/sealed/manifest.json';
    const plugins: SettingsRow = {
      kind: 'set',
      schema: 2,
      name: 'plugins',
      values: { [install]: { value: { bool: true }, at: [1, 0, clock.device] } },
    };
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      asked.push(url);
      if (url === '/routes') return Response.json({});
      if (url.endsWith('/manifest.json')) return Response.json({ id: 'com.den.scout' });
      if (url.includes('/stream/')) return Response.json({ streams: [] });
      return new Response(null, { status: 404 });
    };
    const runtime = new DownloadServiceRuntime(
      testLog([plugins]).log,
      clock,
      () => {},
      content,
      fetchImpl,
    );

    expect(runtime.nextDelay(1)).toBeUndefined();
    await expect(runtime.run()).resolves.toBe(false);
    expect(runtime.nextDelay(1)).toBeUndefined();
    await expect(
      runtime.coordinator.effects.resolve({
        mediaType: 'movie',
        mediaId: 7,
        imdbId: 'tt0000007',
        title: 'Seven',
      }),
    ).resolves.toMatchObject({ sources: [] });
    expect(asked).toContain('/scout/sealed/stream/movie/tt0000007.json');
    expect(asked.some((url) => url.endsWith('/wanted'))).toBe(false);
    expect(runtime.nextDelay(1)).toBeUndefined();
  });

  it('schedules one reopen clear, but no zero-delay loop when no Hearth is configured', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const runtime = new DownloadServiceRuntime(testLog().log, clock, () => {}, content, fetchImpl);

    expect(runtime.nextDelay(1)).toBeUndefined();
    await expect(runtime.run()).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith('/routes');
    expect(runtime.nextDelay(1)).toBeUndefined();
  });

  it('recovers exact episode artwork without exposing a row or ticket', async () => {
    const loadSeason = vi.fn(async () => [
      { number: 2, name: 'Two', stillPath: '/other.jpg' },
      { number: 3, name: 'Three', stillPath: '/episode.jpg' },
    ]);
    const runtime = new DownloadServiceRuntime(
      testLog().log,
      clock,
      () => {},
      content,
      undefined,
      loadSeason,
    );
    await expect(runtime.artwork({ type: 'tv', id: 7, season: 2, episode: 3 })).resolves.toBe(
      '/episode.jpg',
    );
    expect(loadSeason).toHaveBeenCalledWith(7, 2);
    await expect(runtime.artwork({ type: 'movie', id: 7 })).resolves.toBeNull();
    expect(loadSeason).toHaveBeenCalledTimes(1);
  });

  it('treats malformed, missing, and failed artwork as absent', async () => {
    const loadSeason = vi
      .fn()
      .mockResolvedValueOnce([{ number: 1, name: 'One' }])
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('offline'));
    const runtime = new DownloadServiceRuntime(
      testLog().log,
      clock,
      () => {},
      content,
      undefined,
      loadSeason,
    );
    await expect(runtime.artwork({ type: 'tv', id: 7, season: 2, episode: 3 })).resolves.toBeNull();
    await expect(runtime.artwork({ type: 'tv', id: 7, season: 2, episode: 4 })).resolves.toBeNull();
    await expect(runtime.artwork({ type: 'tv', id: 7, season: 2, episode: 5 })).resolves.toBeNull();
  });
});
