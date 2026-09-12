import { expect, it } from 'vitest';
import { downloadSeason, seasonJobs, seasonJobKey } from './seasonDownloads.svelte';
import { DownloadQueue } from './downloadQueue.svelte';
import type { TitleSource } from './titleSources';
it('queues aired season episodes once across repeated clicks, skips ready files, future episodes and dead swarms', async () => {
  seasonJobs.clear();
  const addon = { install: 'http://scout/config', base: '/scout/config' };
  const looked: number[] = [], queued: string[] = [];
  const source = (n: number, cached: boolean, seeders = 10) => ({ filename: `E${n}`, url: `/scout/p/${n}`, cached, seeders, badges: [], languages: [], label: '', probed: false }) satisfies TitleSource;
  const resolve = async (_a: unknown, _i: string, _r: unknown, _s?: number, e?: number) => { looked.push(e!); await Promise.resolve(); return [source(e!, e === 1, e === 3 ? 0 : 10)]; };
  const queue = new DownloadQueue(async (url) => { queued.push(url); return { state: 'preparing' }; });
  const episodes = [1, 2, 3, 4].map(number => ({ number, name: `E${number}`, airDate: number === 4 ? '2099-01-01' : '2020-01-01' }));
  await Promise.all([downloadSeason(addon, 'tt1', 1, episodes, {}, resolve, queue), downloadSeason(addon, 'tt1', 1, episodes, {}, resolve, queue)]);
  expect(looked).toEqual([1, 2, 3]); expect(queued).toEqual(['/scout/p/2']);
  expect(seasonJobs.get(seasonJobKey(addon, 'tt1', 1))).toMatchObject({ total: 3, ready: 1, queued: 1, unavailable: 1, running: false });
});
