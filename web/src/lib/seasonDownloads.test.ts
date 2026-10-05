import { expect, it } from 'vitest';
import { downloadSeason, seasonJobs, seasonJobKey } from './seasonDownloads.svelte';
import { DownloadQueue } from './downloadQueue.svelte';
import { readDownloads } from './downloadRows';
import { source, testClock, testLog } from './downloadTestLog';

it('queues aired season episodes once across repeated clicks, skips ready files, future episodes and dead swarms', async () => {
  seasonJobs.clear();
  const addon = { install: 'http://scout/config', base: '/scout/config' };
  const looked: number[] = [],
    queued: string[] = [];
  const release = (n: number, cached: boolean, seeders = 10) =>
    source(`E${n}`, { cached, seeders, resolution: '1080p' }, String(n));
  const resolve = async (_a: unknown, _i: string, _r: unknown, _s?: number, e?: number) => {
    looked.push(e!);
    await Promise.resolve();
    return { sources: [release(e!, e === 1, e === 3 ? 0 : 10)] };
  };
  const shared = testLog();
  const queue = new DownloadQueue(async (url) => {
    queued.push(url);
    return { state: 'preparing' };
  });
  queue.attach(shared.log, testClock('bbbbbbbbbbbbbbbb'));
  const episodes = [1, 2, 3, 4].map((number) => ({
    number,
    name: `E${number}`,
    stillPath: `/still-${number}.jpg`,
    airDate: number === 4 ? '2099-01-01' : '2020-01-01',
  }));
  const series = { type: 'tv' as const, id: 77, title: 'Series' };
  await Promise.all([
    downloadSeason(addon, 'tt1', 1, episodes, {}, series, resolve, queue),
    downloadSeason(addon, 'tt1', 1, episodes, {}, series, resolve, queue),
  ]);
  expect(looked).toEqual([1, 2, 3]);
  expect(queued).toEqual(['/scout/p/2']);
  expect(seasonJobs.get(seasonJobKey(addon, 'tt1', 1))).toMatchObject({
    total: 3,
    ready: 1,
    queued: 1,
    unavailable: 1,
    running: false,
  });
  // One row per episode started, for every device to show.
  const saved = readDownloads(shared.log.rows());
  expect(saved.map((d) => d.content)).toEqual(['tv:77:1:2']);
  expect(saved[0]?.title.stillPath).toBe('/still-2.jpg');

  // A second press leaves the episode in flight alone: asking again would be a fresh add at the debrid.
  await downloadSeason(addon, 'tt1', 1, episodes, {}, series, resolve, queue);
  expect(queued).toEqual(['/scout/p/2']);
});
