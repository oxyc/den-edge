import { describe, expect, it, vi } from 'vitest';
import { downloadEpisode, downloadSeason } from './seasonDownloads.svelte';
import type { LibraryModel } from './libraryModel.svelte';

const episode = { number: 2, name: 'Two', airDate: '2020-01-01' };
const title = { type: 'tv' as const, id: 7, title: 'Series' };
const model = (releases: unknown[]) =>
  ({
    downloadReleases: vi.fn(async () => ({
      result: { kind: 'download.releases', releases },
      version: {},
    })),
    enqueueDownload: vi.fn(async () => ({})),
  }) as unknown as LibraryModel;

describe('semantic season downloads', () => {
  it('queues the service-ranked identity without receiving a ticket', async () => {
    const library = model([{ identity: 'one', label: 'One', cached: false }]);
    await expect(downloadEpisode(library, 'tt1', 1, episode, title)).resolves.toBe('queued');
    expect(library.enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({ target: { type: 'tv', id: 7, season: 1, episode: 2 } }),
      { identity: 'one', label: 'One', cached: false },
      1,
    );
  });

  it('reports local progress while the service owns each durable episode', async () => {
    const library = model([{ identity: 'one', label: 'One', cached: true }]);
    const updates: Array<{ checked: number; running: boolean }> = [];
    await downloadSeason(library, 'tt1', 1, [episode], title, (job) => updates.push(job));
    expect(updates.at(-1)).toMatchObject({ checked: 1, ready: 1, running: false });
  });
});
