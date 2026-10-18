import { describe, expect, it, vi } from 'vitest';
import { downloadEpisode, downloadSeason } from './seasonDownloads.svelte';
import type { LibraryModel } from './libraryModel.svelte';
import type { DownloadViewItem } from './libraryServiceProtocol';

const episodes = [
  { number: 1, name: 'One', airDate: '2020-01-01' },
  { number: 2, name: 'Two', airDate: '2020-01-02' },
];
const title = { type: 'tv' as const, id: 7, title: 'Series' };
const source = {
  identity: 'one',
  label: 'One',
  filename: 'one.mkv',
  cached: false,
  badges: [],
  languages: [],
  probed: false,
};

function model(resolve = vi.fn(async () => [source])) {
  const items: DownloadViewItem[] = [];
  const release = vi.fn();
  const library = {
    downloads: vi.fn(() => ({ snapshot: { value: { kind: 'downloads', items } }, release })),
    downloadSources: vi.fn(async () => ({
      result: { kind: 'download.sources', sources: await resolve() },
      version: {},
    })),
    enqueueDownload: vi.fn(async (requested) => {
      items.push({
        content: `tv:7:${requested.target.season}:${requested.target.episode}`,
        title: { type: 'tv', id: 7 },
        name: 'Series',
        season: requested.target.season,
        episode: requested.target.episode,
        queuedAt: 1,
        queuedBy: { device: 'self', isSelf: true },
        release: { identity: 'one', label: 'One' },
        status: { state: 'starting', phase: 'queued', stalled: false },
        tried: 1,
        announced: false,
      });
    }),
  };
  return { library: library as unknown as LibraryModel, release, resolve };
}

describe('semantic season downloads', () => {
  it('queues the service-ranked identity without receiving a ticket', async () => {
    const { library } = model();
    await expect(downloadEpisode(library, 'tt1', 1, episodes[1]!, title)).resolves.toBe('queued');
    expect(library.enqueueDownload).toHaveBeenCalledWith(
      expect.objectContaining({ target: { type: 'tv', id: 7, season: 1, episode: 2 } }),
      source,
      1,
    );
    expect(
      JSON.stringify((library.enqueueDownload as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain('/scout/');
  });

  it('coalesces concurrent runs and makes a repeated completed run idempotent', async () => {
    const { library, resolve } = model();
    const first: Array<{ checked: number; running: boolean }> = [];
    const second: Array<{ checked: number; running: boolean }> = [];
    await Promise.all([
      downloadSeason(library, 'tt1', 1, episodes, title, (job) => first.push(job)),
      downloadSeason(library, 'tt1', 1, episodes, title, (job) => second.push(job)),
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(library.enqueueDownload).toHaveBeenCalledTimes(2);
    expect(first.at(-1)).toMatchObject({ checked: 2, queued: 2, running: false });
    expect(second.at(-1)).toMatchObject({ checked: 2, queued: 2, running: false });

    await downloadSeason(library, 'tt1', 1, episodes, title, () => {});
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(library.enqueueDownload).toHaveBeenCalledTimes(2);
  });

  it('settles errors, releases its lease, and keeps checking the season', async () => {
    let call = 0;
    const { library, release } = model(
      vi.fn(async () => {
        if (call++ === 0) throw new Error('provider down');
        return [source];
      }),
    );
    const updates: Array<{ uncertain: number; queued: number; running: boolean }> = [];
    await expect(
      downloadSeason(library, 'tt1', 1, episodes, title, (job) => updates.push(job)),
    ).resolves.toBeUndefined();
    expect(updates.at(-1)).toMatchObject({ uncertain: 1, queued: 1, running: false });
    expect(release).toHaveBeenCalledOnce();
  });

  it('leaves every episode of a sparse season as a download that keeps trying', async () => {
    const season = [
      { number: 1, name: 'One', airDate: '2020-01-01' },
      { number: 2, name: 'Two', airDate: '2020-01-08' },
      { number: 3, name: 'Three', airDate: '2020-01-15' },
      { number: 4, name: 'Four', airDate: '2020-01-22' },
      { number: 5, name: 'Five', airDate: '2999-01-01' },
    ];
    const listed: Record<number, unknown[]> = {
      1: [{ ...source, identity: 'e1', cached: true }],
      2: [{ ...source, identity: 'e2', seeders: 3 }],
      3: [],
      4: [{ ...source, identity: 'e4', seeders: 0 }],
    };
    const { library } = model();
    let asking = 0;
    (library as unknown as { downloadSources: unknown }).downloadSources = vi.fn(
      async (requested: { target: { episode: number } }) => {
        asking = requested.target.episode;
        return { result: { kind: 'download.sources', sources: listed[asking] }, version: {} };
      },
    );
    const wanted: Array<{ target: { episode: number }; airDate?: number }> = [];
    (library as unknown as { wantDownload: unknown }).wantDownload = vi.fn(async (requested) => {
      wanted.push(requested);
    });
    const updates: Array<Record<string, number | boolean>> = [];
    await downloadSeason(library, 'tt6623682', 2, season, title, (job) => updates.push({ ...job }));

    expect(updates.at(-1)).toMatchObject({
      total: 5,
      checked: 5,
      ready: 1,
      queued: 1,
      searching: 2,
      waiting: 1,
      uncertain: 0,
      running: false,
    });
    expect(library.enqueueDownload).toHaveBeenCalledTimes(1);
    expect(wanted.map(({ target }) => target.episode)).toEqual([3, 4, 5]);
    expect(wanted[2]!.airDate).toBe(Date.parse('2999-01-01T00:00:00Z'));
    // An unaired episode has nothing to search for yet.
    expect(library.downloadSources).toHaveBeenCalledTimes(4);
  });

  it('stops publishing to an observer that has been cancelled', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { library } = model(
      vi.fn(async () => {
        await gate;
        return [source];
      }),
    );
    const controller = new AbortController();
    const updates: number[] = [];
    const running = downloadSeason(
      library,
      'tt1',
      1,
      [episodes[0]!],
      title,
      (job) => updates.push(job.checked),
      controller.signal,
    );
    controller.abort();
    finish();
    await running;
    expect(updates).toEqual([0]);
  });
});
