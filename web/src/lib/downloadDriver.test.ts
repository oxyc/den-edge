import { describe, expect, it } from 'vitest';
import { driveDownloads } from './downloadDriver';
import { DownloadQueue, type Resolve } from './downloadQueue.svelte';
import {
  clockValue,
  downloadName,
  LEASE_ROW,
  readDownload,
  releaseValue,
  titleValue,
} from './downloadRows';
import { source, testClock, testLog } from './downloadTestLog';
import type { SettingsRow } from './wire';

const TV = 'aaaaaaaaaaaaaaaa';
const BROWSER = 'bbbbbbbbbbbbbbbb';
const MINUTE = 60_000;
const T0 = 1_800_000_000_000;
const NAME = downloadName('tv:1399:2:3');

const first = source('Rebecka.S02E03.2160p.AMZN.WEB-DL.mkv', {
  resolution: '2160p',
  cached: false,
  seeders: 20,
});
const second = source('Rebecka.S02E03.1080p.WEB.h264-GRP.mkv', {
  resolution: '1080p',
  cached: false,
  seeders: 20,
});

/** The TV queued episode 3 at T0 with the first release, and den-scout has reported nothing moving since. */
function stalledRow(): SettingsRow {
  const at: [number, number, string] = [T0, 0, TV];
  return {
    kind: 'set',
    schema: 2,
    name: NAME,
    values: {
      release: {
        value: releaseValue({
          identity: first.identity,
          label: first.label,
          url: first.url,
          cached: false,
        }),
        at,
      },
      title: {
        value: titleValue({
          mediaType: 'tv',
          mediaId: 1399,
          imdbId: 'tt1',
          season: 2,
          episode: 3,
          title: 'Rebecka Martinsson',
        }),
        at,
      },
      queuedAt: { value: { int: T0 }, at },
      progress: { value: clockValue({ lastProgress: 0, progressAt: T0 }), at },
    },
  };
}

const leaseRow = (holder: string, epoch: number): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name: LEASE_ROW,
  values: { lease: { value: { strings: [holder, String(epoch)] }, at: [T0, 0, holder || TV] } },
});

function browserQueue(resolve: Resolve) {
  const asked: string[] = [];
  const queue = new DownloadQueue(
    async (url, add) => {
      asked.push(`${add ? 'add' : 'probe'} ${url}`);
      return { state: 'preparing', progress: 0, bytesPerSecond: 0 };
    },
    async () => true,
  );
  return { queue, asked, resolve };
}

describe('the download driver', () => {
  it('falls back only while it holds the lease', async () => {
    const shared = testLog([stalledRow(), leaseRow(TV, 3)]);
    const { queue, asked } = browserQueue(async () => ({ sources: [first, second] }));
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => ({
      sources: [first, second],
    }));

    // The TV holds the lease and renews it: the browser polls what it shows, and writes nothing.
    const now = T0 + 21 * MINUTE;
    await driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 });
    expect(readDownload(shared.log.settings(NAME)!)!.release.identity).toBe(first.identity);
    expect(shared.writes).toEqual([]);
    expect(asked).toEqual([`probe ${first.url}`]);

    // The TV went quiet: ten minutes with the lease row unchanged, and the browser takes it and moves on.
    await driveDownloads(shared.log, queue, BROWSER, { now: now + 11 * MINUTE, observedFor: 0 });
    const lease = shared.log.settings(LEASE_ROW)!.values.lease!.value;
    expect(lease).toEqual({ strings: [BROWSER, '4'] });
    const moved = readDownload(shared.log.settings(NAME)!)!;
    expect(moved.release.identity).toBe(second.identity);
    expect(moved.tried).toEqual([first.identity]);
    expect(moved.candidates).toBe(2);
    expect(asked.at(-1)).toBe(`add ${second.url}`);
  });

  it('a fallback whose row changed under it is dropped and decided again', async () => {
    const shared = testLog([stalledRow()]);
    const { queue, asked } = browserQueue(async () => ({ sources: [first, second] }));
    // While the fallback resolves, the TV writes the row (a fresh `queuedAt` from a Download press there).
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => {
      const row = shared.log.settings(NAME)!;
      shared.land({
        ...row,
        values: {
          ...row.values,
          queuedAt: { value: { int: T0 + 30 * MINUTE }, at: [T0 + 30 * MINUTE, 0, TV] },
        },
      });
      return { sources: [first, second] };
    });

    await driveDownloads(shared.log, queue, BROWSER, { now: T0 + 21 * MINUTE, observedFor: 0 });
    // The lease was free, so the browser holds it — and still changed nothing in the row it decided on a stale read.
    expect(shared.log.settings(LEASE_ROW)!.values.lease!.value).toEqual({
      strings: [BROWSER, '1'],
    });
    const row = readDownload(shared.log.settings(NAME)!)!;
    expect(row.release.identity).toBe(first.identity);
    expect(row.tried).toEqual([]);
    expect(asked).not.toContain(`add ${second.url}`);
    // Compare-and-set on the seq it read: den-edge refused it, and nothing was merged and sent again.
    expect(shared.writes.filter((w) => w.includes(NAME))).toEqual([`conflict set:${NAME}`]);
  });

  it('only the holder writes that den-scout described a download, and that it is ready', async () => {
    const shared = testLog([stalledRow(), leaseRow(TV, 3)]);
    const ready = new DownloadQueue(async () => ({ state: 'ready' }));
    ready.attach(shared.log, testClock(BROWSER));
    await driveDownloads(shared.log, ready, BROWSER, { now: T0 + MINUTE, observedFor: 0 });
    expect(ready.status(ready.list()[0]!).announce).toBe(true);
    expect(readDownload(shared.log.settings(NAME)!)!.announced).toBe(false);

    const holder = testLog([stalledRow()]);
    const mine = new DownloadQueue(async () => ({ state: 'ready' }));
    mine.attach(holder.log, testClock(BROWSER));
    await driveDownloads(holder.log, mine, BROWSER, { now: T0 + MINUTE, observedFor: 0 });
    const read = readDownload(holder.log.settings(NAME)!)!;
    expect(read.announced).toBe(true);
    expect(read.reported).toBe(true);
  });
});
