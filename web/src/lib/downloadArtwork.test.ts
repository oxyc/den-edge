import { describe, expect, it, vi } from 'vitest';
import { downloadStill } from './downloadArtwork';
import type { DownloadTitle } from './downloadRows';

const episode = (overrides: Partial<DownloadTitle> = {}): DownloadTitle => ({
  mediaType: 'tv',
  mediaId: 1399,
  season: 2,
  episode: 4,
  title: 'A Series',
  ...overrides,
});

describe('downloadStill', () => {
  it('uses the still already stored in a new shared row', async () => {
    const load = vi.fn();
    await expect(downloadStill(episode({ stillPath: '/stored.jpg' }), load)).resolves.toBe(
      '/stored.jpg',
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('recovers the exact episode still for an older row', async () => {
    const load = vi.fn().mockResolvedValue([
      { number: 3, name: 'Three', stillPath: '/three.jpg' },
      { number: 4, name: 'Four', stillPath: '/four.jpg' },
    ]);
    await expect(downloadStill(episode(), load)).resolves.toBe('/four.jpg');
    expect(load).toHaveBeenCalledWith(1399, 2, 'den-proxy');
  });

  it('shares an in-flight recovery and its answer across windowed-card remounts', async () => {
    let finish!: (episodes: { number: number; name: string; stillPath: string }[]) => void;
    const answer = new Promise<{ number: number; name: string; stillPath: string }[]>(
      (resolve) => (finish = resolve),
    );
    const load = vi.fn(() => answer);
    const first = downloadStill(episode(), load);
    const remounted = downloadStill(episode(), load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);

    finish([{ number: 4, name: 'Four', stillPath: '/four.jpg' }]);
    await expect(Promise.all([first, remounted])).resolves.toEqual(['/four.jpg', '/four.jpg']);
    await expect(downloadStill(episode(), load)).resolves.toBe('/four.jpg');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps null and rejected recoveries quiet across remounts, then retries them', async () => {
    let at = 1_000;
    const now = () => at;
    const missing = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([{ number: 4, name: 'Four', stillPath: '/four.jpg' }]);
    await expect(downloadStill(episode(), missing, now)).resolves.toBeUndefined();
    await expect(downloadStill(episode(), missing, now)).resolves.toBeUndefined();
    expect(missing).toHaveBeenCalledTimes(1);
    at += 30_001;
    await expect(downloadStill(episode(), missing, now)).resolves.toBe('/four.jpg');
    expect(missing).toHaveBeenCalledTimes(2);

    const refused = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ number: 5, name: 'Five', stillPath: '/five.jpg' }]);
    const fifth = episode({ episode: 5 });
    await expect(downloadStill(fifth, refused, now)).rejects.toThrow('offline');
    await expect(downloadStill(fifth, refused, now)).resolves.toBeUndefined();
    expect(refused).toHaveBeenCalledTimes(1);
    at += 30_001;
    await expect(downloadStill(fifth, refused, now)).resolves.toBe('/five.jpg');
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('does not perform a season lookup for a movie', async () => {
    const load = vi.fn();
    await expect(
      downloadStill(episode({ mediaType: 'movie', season: undefined, episode: undefined }), load),
    ).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});
