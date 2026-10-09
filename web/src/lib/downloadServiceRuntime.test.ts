import { describe, expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import type { DownloadContent } from './downloadServiceRuntime';
import { DownloadServiceRuntime } from './downloadServiceRuntime';
import { testLog } from './downloadTestLog';

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
