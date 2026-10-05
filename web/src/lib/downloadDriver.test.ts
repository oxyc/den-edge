import { describe, expect, it } from 'vitest';
import { driveDownloads, holdLease, refreshDownloads, stillHeld } from './downloadDriver';
import {
  DownloadQueue,
  POLL_MAX_MS,
  type DownloadState,
  type Resolve,
} from './downloadQueue.svelte';
import {
  clockValue,
  downloadName,
  LEASE_ROW,
  readDownload,
  releaseValue,
  titleValue,
} from './downloadRows';
import { source, testClock, testLog } from './downloadTestLog';
import type { Row, SettingsRow, WatchRow } from './wire';

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
function stalledRow(episode = 3): SettingsRow {
  const at: [number, number, string] = [T0, 0, TV];
  return {
    kind: 'set',
    schema: 2,
    name: downloadName(`tv:1399:2:${episode}`),
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
          episode,
          title: 'Rebecka Martinsson',
        }),
        at,
      },
      queuedAt: { value: { int: T0 }, at },
      progress: { value: clockValue({ lastProgress: 0, progressAt: T0 }), at },
    },
  };
}

function partialRow(episode = 3): SettingsRow {
  const row = stalledRow(episode);
  return {
    ...row,
    values: {
      ...row.values,
      progress: {
        value: clockValue({ lastProgress: 0.5, progressAt: T0 }),
        at: [T0, 0, TV],
      },
    },
  };
}

function hedgedRow(): SettingsRow {
  const row = partialRow();
  const at: [number, number, string] = [T0, 0, TV];
  return {
    ...row,
    values: {
      ...row.values,
      release: {
        value: releaseValue({
          identity: first.identity,
          label: first.label,
          url: first.url,
          cached: false,
          hedge: {
            identity: second.identity,
            label: second.label,
            url: second.url,
            cached: false,
            queuedAt: T0,
            lastProgress: 0,
            progressAt: T0,
          },
        }),
        at,
      },
    },
  };
}

function exhaustedRow(): SettingsRow {
  const row = stalledRow();
  return {
    ...row,
    values: {
      ...row.values,
      tried: { value: { strings: [first.identity] }, at: [T0, 0, TV] },
      exhausted: { value: { bool: true }, at: [T0, 0, TV] },
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
  it('keeps an exhausted request and retries fresh sources on a bounded schedule', async () => {
    const shared = testLog([exhaustedRow()]);
    const { queue, asked } = browserQueue(async () => ({ sources: [first, second] }));
    let resolves = 0;
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => {
      resolves++;
      return { sources: [first, second] };
    });

    await driveDownloads(shared.log, queue, BROWSER, {
      now: T0 + 6 * 60 * MINUTE,
      observedFor: 0,
    });
    const retried = readDownload(shared.log.settings(NAME)!)!;
    expect(resolves).toBe(1);
    expect(retried.exhausted).toBe(false);
    expect(retried.release.identity).toBe(second.identity);
    expect(asked).toContain(`add ${second.url}`);
  });

  it('drops an exhausted retry result when the active library changes', async () => {
    const shared = testLog([exhaustedRow()]);
    const next = testLog([exhaustedRow()]);
    const { queue, asked } = browserQueue(async () => ({ sources: [first, second] }));
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => {
      queue.attach(next.log, testClock(BROWSER), undefined, async () => ({
        sources: [first, second],
      }));
      return { sources: [first, second] };
    });

    await driveDownloads(shared.log, queue, BROWSER, {
      now: T0 + 6 * 60 * MINUTE,
      observedFor: 0,
    });

    expect(readDownload(shared.log.settings(NAME)!)!.exhausted).toBe(true);
    expect(asked).not.toContain(`add ${second.url}`);
  });

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

  it('keeps a stalled partial primary while an alternate starts, then promotes the alternate winner', async () => {
    const shared = testLog([partialRow()]);
    const asked: string[] = [];
    const cancelled: string[] = [];
    const queue = new DownloadQueue(
      async (url, add) => {
        asked.push(`${add ? 'add' : 'probe'} ${url}`);
        if (url === second.url && !add) return { state: 'ready' };
        return { state: 'preparing', progress: url === first.url ? 0.5 : 0.1 };
      },
      async (url) => (cancelled.push(url), true),
    );
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => ({
      sources: [first, second],
    }));

    await driveDownloads(shared.log, queue, BROWSER, { now: T0 + 21 * MINUTE, observedFor: 0 });
    const racing = readDownload(shared.log.settings(NAME)!)!;
    expect(racing.release.identity).toBe(first.identity);
    expect(racing.release.hedge?.identity).toBe(second.identity);
    expect(cancelled).toEqual([]);

    await driveDownloads(shared.log, queue, BROWSER, {
      now: T0 + 21 * MINUTE + 5_000,
      observedFor: 0,
    });
    const won = readDownload(shared.log.settings(NAME)!)!;
    expect(won.release.identity).toBe(second.identity);
    expect(won.release.hedge).toBeUndefined();
    expect(cancelled).toEqual([first.url]);
    expect(asked).toContain(`add ${second.url}`);
  });

  it('keeps the original when it recovers first and cancels only the alternate', async () => {
    const shared = testLog([partialRow()]);
    const cancelled: string[] = [];
    let primaryPolls = 0;
    const queue = new DownloadQueue(
      async (url, add) => {
        if (url === first.url && !add && ++primaryPolls > 1) return { state: 'ready' };
        return { state: 'preparing', progress: url === first.url ? 0.5 : 0.1 };
      },
      async (url) => (cancelled.push(url), true),
    );
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => ({
      sources: [first, second],
    }));

    await driveDownloads(shared.log, queue, BROWSER, { now: T0 + 21 * MINUTE, observedFor: 0 });
    await driveDownloads(shared.log, queue, BROWSER, {
      now: T0 + 21 * MINUTE + 5_000,
      observedFor: 0,
    });
    const won = readDownload(shared.log.settings(NAME)!)!;
    expect(won.release.identity).toBe(first.identity);
    expect(won.release.hedge).toBeUndefined();
    expect(cancelled).toEqual([second.url]);
  });

  it('resumes once when a persisted alternate was not added before the prior pass stopped', async () => {
    const shared = testLog([partialRow()]);
    let hedgeAdds = 0;
    let hedgeQueued = false;
    const queue = new DownloadQueue(async (url, add) => {
      if (url === second.url && add) {
        hedgeAdds++;
        if (hedgeAdds === 1) throw new Error('holder stopped after persisting the hedge');
        hedgeQueued = true;
        return { state: 'preparing', progress: 0.1 };
      }
      if (url === second.url)
        return hedgeQueued ? { state: 'preparing', progress: 0.1 } : { state: 'not-queued' };
      return { state: 'preparing', progress: 0.5 };
    });
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => ({
      sources: [first, second],
    }));
    const now = T0 + 21 * MINUTE;

    await expect(
      driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 }),
    ).rejects.toThrow('holder stopped');
    expect(readDownload(shared.log.settings(NAME)!)!.release.hedge?.identity).toBe(second.identity);

    await driveDownloads(shared.log, queue, BROWSER, { now: now + 5_000, observedFor: 0 });
    await driveDownloads(shared.log, queue, BROWSER, { now: now + 10_000, observedFor: 0 });
    expect(hedgeAdds).toBe(2);
  });

  it('writes moving alternate progress no more than once per maximum poll interval', async () => {
    const shared = testLog([partialRow()]);
    let hedgeProgress = 0;
    const queue = new DownloadQueue(async (url, add) => {
      if (url === second.url) {
        hedgeProgress = add ? 0.1 : hedgeProgress + 0.1;
        return { state: 'preparing', progress: hedgeProgress };
      }
      return { state: 'preparing', progress: 0.5 };
    });
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => ({
      sources: [first, second],
    }));
    const now = T0 + 21 * MINUTE;

    await driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 });
    const writesAfterStart = shared.writes.filter((write) => write.includes(NAME)).length;
    await driveDownloads(shared.log, queue, BROWSER, { now: now + 5_000, observedFor: 0 });
    expect(shared.writes.filter((write) => write.includes(NAME))).toHaveLength(writesAfterStart);

    await driveDownloads(shared.log, queue, BROWSER, {
      now: now + POLL_MAX_MS,
      observedFor: 0,
    });
    expect(shared.writes.filter((write) => write.includes(NAME))).toHaveLength(
      writesAfterStart + 1,
    );
    expect(readDownload(shared.log.settings(NAME)!)!.release.hedge?.lastProgress).toBeGreaterThan(
      0.1,
    );
  });

  it('caches a definitive no-alternate answer for ten minutes and invalidates it on a fresh queue time', async () => {
    const shared = testLog([partialRow()]);
    let resolves = 0;
    const queue = new DownloadQueue(async () => ({ state: 'preparing', progress: 0.5 }));
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => {
      resolves++;
      return { sources: [first], answer: { kind: 'live', missing: 0 } };
    });
    const now = T0 + 21 * MINUTE;

    await driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 });
    await driveDownloads(shared.log, queue, BROWSER, { now: now + 5_000, observedFor: 0 });
    expect(resolves).toBe(1);

    const row = shared.log.settings(NAME)!;
    shared.land({
      ...row,
      values: {
        ...row.values,
        queuedAt: { value: { int: T0 + 1 }, at: [T0 + 1, 0, TV] },
      },
    });
    await driveDownloads(shared.log, queue, BROWSER, { now: now + 10_000, observedFor: 0 });
    expect(resolves).toBe(2);

    for (let minute = 1; minute <= 10; minute++)
      await driveDownloads(shared.log, queue, BROWSER, {
        now: now + 10_000 + minute * MINUTE,
        observedFor: 0,
      });
    expect(resolves).toBe(3);
  });

  it('does not cache partial, unknown, stale, outage, or missing-source answers', async () => {
    const answers = [
      { kind: 'partial' as const, missing: 0 },
      { kind: 'unknown' as const, missing: 0 },
      { kind: 'stale' as const, missing: 0 },
      { kind: 'live' as const, missing: 0, outage: { builtAt: T0 } },
      { kind: 'live' as const, missing: 1 },
    ];
    for (const answer of answers) {
      const shared = testLog([partialRow()]);
      let resolves = 0;
      const queue = new DownloadQueue(async () => ({ state: 'preparing', progress: 0.5 }));
      queue.attach(shared.log, testClock(BROWSER), undefined, async () => {
        resolves++;
        return { sources: [first], answer };
      });
      const now = T0 + 21 * MINUTE;
      await driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 });
      await driveDownloads(shared.log, queue, BROWSER, { now: now + 5_000, observedFor: 0 });
      expect(resolves, answer.kind).toBe(2);
    }
  });

  it('does not remember or start an alternate when the lease is lost during resolve', async () => {
    const shared = testLog([partialRow()]);
    const queue = new DownloadQueue(async () => ({ state: 'preparing', progress: 0.5 }));
    queue.attach(shared.log, testClock(BROWSER), undefined, async () => {
      shared.land(leaseRow(TV, 9));
      return { sources: [first, second], answer: { kind: 'live', missing: 0 } };
    });
    const now = T0 + 21 * MINUTE;
    await driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 });

    expect(readDownload(shared.log.settings(NAME)!)!.release.hedge).toBeUndefined();
    expect(queue.hedgeResolveDue(queue.list()[0]!, now)).toBe(true);
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

  it('a prune compare-and-sets on the row it decided on, not one read after', async () => {
    // Two watched episodes that finished three days ago: past their recent-history window.
    const finished = (name: string, episode: number): SettingsRow => {
      const row = stalledRow();
      const at: [number, number, string] = [T0, 0, TV];
      return {
        ...row,
        name,
        values: {
          ...row.values,
          title: {
            value: titleValue({ mediaType: 'tv', mediaId: 1399, season: 2, episode, title: 'R' }),
            at,
          },
          reported: { value: { bool: true }, at },
          announced: { value: { bool: true }, at },
        },
      };
    };
    const other = downloadName('tv:1399:2:4');
    const shared = testLog([finished(NAME, 3), finished(other, 4)]);
    // Both episodes watched: unwatched ready rows never age out, while these are old enough to prune. That gives
    // this test the removal it needs to exercise the compare-and-set race.
    // `episode_state` (den-core) reads visibility against the real wall clock, not this test's synthetic
    // timeline, so the mark's own stamp must be in the real past.
    const watchedAt: [number, number, string] = [Date.now() - MINUTE, 0, TV];
    const watchRow = (episode: number): Row =>
      ({
        kind: 'wat',
        schema: 3,
        title: { type: 'tv', id: 1399 },
        season: 2,
        block: 0,
        seasonReset: null,
        entries: {
          [episode]: {
            imported: false,
            progress: { value: 1, at: watchedAt, viewing: 0 },
            plays: {},
            cleared: null,
          },
        },
      }) satisfies WatchRow;
    const baseRows = shared.log.rows.bind(shared.log);
    shared.log.rows = () => [...baseRows(), watchRow(3), watchRow(4)];
    const queue = new DownloadQueue(async () => ({ state: 'ready' }));
    queue.attach(shared.log, testClock(BROWSER));
    const now = T0 + 3 * 1440 * MINUTE;
    // While the first tombstone is written, the TV queues the other episode again.
    const writeAt = shared.log.writeAt.bind(shared.log);
    let requeued: string | undefined;
    (shared.log as { writeAt: typeof writeAt }).writeAt = async (
      row: SettingsRow,
      base: number,
    ) => {
      const ok = await writeAt(row, base);
      if (!requeued && row.values.removed) {
        requeued = row.name === NAME ? other : NAME;
        const live = shared.log.settings(requeued)!;
        shared.land({
          ...live,
          values: { ...live.values, queuedAt: { value: { int: now }, at: [now, 0, TV] } },
        });
      }
      return ok;
    };
    await driveDownloads(shared.log, queue, BROWSER, { now, observedFor: 0 });
    expect(requeued).toBeDefined();
    expect(readDownload(shared.log.settings(requeued!)!)).not.toBeNull();
  });

  /** A ready row the library holds no watched mark for: old enough that the pre-den#202 two-day limit would
   * have pruned it, and still live. */
  function readyUnwatched(): SettingsRow {
    const row = stalledRow();
    const at: [number, number, string] = [T0, 0, TV];
    return {
      ...row,
      values: {
        ...row.values,
        reported: { value: { bool: true }, at },
        announced: { value: { bool: true }, at },
      },
    };
  }

  it('a ready row with nothing watched behind it outlives the old two-day limit', async () => {
    const shared = testLog([readyUnwatched()]);
    const queue = new DownloadQueue(async () => ({ state: 'ready' }));
    queue.attach(shared.log, testClock(BROWSER));
    await driveDownloads(shared.log, queue, BROWSER, {
      now: T0 + 3 * 1440 * MINUTE,
      observedFor: 0,
    });
    expect(readDownload(shared.log.settings(NAME)!)).not.toBeNull();
  });

  it('a watched ready row remains visible as recent download history', async () => {
    const shared = testLog([readyUnwatched()]);
    const watched: WatchRow = {
      kind: 'wat',
      schema: 3,
      title: { type: 'tv', id: 1399 },
      season: 2,
      block: 0,
      seasonReset: null,
      entries: {
        3: {
          imported: false,
          progress: { value: 1, at: [Date.now() - MINUTE, 0, TV], viewing: 0 },
          plays: {},
          cleared: null,
        },
      },
    };
    const baseRows = shared.log.rows.bind(shared.log);
    shared.log.rows = () => [...baseRows(), watched];
    const queue = new DownloadQueue(async () => ({ state: 'ready' }));
    queue.attach(shared.log, testClock(BROWSER));
    await driveDownloads(shared.log, queue, BROWSER, {
      now: T0 + 1440 * MINUTE,
      observedFor: 0,
    });
    expect(readDownload(shared.log.settings(NAME)!)).not.toBeNull();
  });
});

describe('download refresh', () => {
  it('runs at most four probes at once', async () => {
    const shared = testLog(Array.from({ length: 9 }, (_, index) => partialRow(index + 1)));
    let active = 0;
    let maximum = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const queue = new DownloadQueue(async () => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return { state: 'preparing', progress: 0.5 };
    });
    queue.attach(shared.log, testClock(BROWSER));

    const refreshing = refreshDownloads(queue, { now: T0 + 21 * MINUTE, force: true });
    await Promise.resolve();
    expect(calls).toBe(4);
    release();
    await refreshing;
    expect(calls).toBe(9);
    expect(maximum).toBe(4);
  });

  it('forces active rows but skips ready and terminal rows', async () => {
    const shared = testLog(Array.from({ length: 5 }, (_, index) => partialRow(index + 1)));
    let calls = 0;
    const queue = new DownloadQueue(async () => {
      calls++;
      return { state: 'preparing', progress: 0.5 };
    });
    queue.attach(shared.log, testClock(BROWSER));
    const status = queue.status.bind(queue);
    const states: DownloadState['state'][] = [
      'ready',
      'paused',
      'no_working_release',
      'release_gone',
      'fetching',
    ];
    queue.status = (download, now) => ({
      ...status(download, now),
      state: states[(download.title.episode ?? 1) - 1]!,
    });

    await refreshDownloads(queue, { now: T0 + 21 * MINUTE, force: true });
    expect(calls).toBe(1);
  });

  it('stops after the active library changes and does not back off the new session', async () => {
    const old = testLog([hedgedRow()]);
    const next = testLog([hedgedRow()]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (started = resolve));
    let calls = 0;
    const queue = new DownloadQueue(async () => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return { state: 'preparing', progress: 0.5 };
    });
    queue.attach(old.log, testClock(BROWSER));

    const stale = refreshDownloads(queue, { now: T0 + 21 * MINUTE, force: true });
    await entered;
    queue.attach(next.log, testClock(BROWSER));
    release();
    await stale;
    expect(calls).toBe(1);

    await refreshDownloads(queue, { now: T0 + 21 * MINUTE });
    expect(calls).toBe(3); // The new session's primary and persisted alternate were both probed.
  });

  it('does not start later batches after its page is no longer active', async () => {
    const shared = testLog(Array.from({ length: 9 }, (_, index) => partialRow(index + 1)));
    let active = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const queue = new DownloadQueue(async () => {
      calls++;
      await gate;
      return { state: 'preparing', progress: 0.5 };
    });
    queue.attach(shared.log, testClock(BROWSER));

    const refreshing = refreshDownloads(queue, {
      now: T0 + 21 * MINUTE,
      force: true,
      shouldContinue: () => active,
    });
    await Promise.resolve();
    expect(calls).toBe(4);
    active = false;
    release();
    await refreshing;
    expect(calls).toBe(4);
  });
});

describe('the download lease', () => {
  it('two windows of one browser never take it from each other', async () => {
    const shared = testLog();
    const a = shared.log;
    const b = shared.window();
    expect(await holdLease(a, BROWSER, T0, 0)).toBe(true);
    expect(stillHeld(a, BROWSER, T0)).toBe(true);

    // Window B sees the row name this browser, at an epoch it never took: another window's, watched like any holder.
    for (let at = T0 + 30_000; at <= T0 + 9 * MINUTE; at += 30_000) {
      expect(await holdLease(b, BROWSER, at, 0)).toBe(false);
      expect(await holdLease(a, BROWSER, at, 0)).toBe(true);
    }
    const leaseWrites = shared.writes.filter((w) => w.includes(LEASE_ROW));
    expect(leaseWrites.every((w) => w.startsWith('writeAt'))).toBe(true);
    // The first take, then A's renewals every 60 s up to nine minutes: nothing from B, no taking back and forth.
    expect(leaseWrites.length).toBe(1 + 9);
    expect(shared.log.settings(LEASE_ROW)!.values.lease!.value).toEqual({
      strings: [BROWSER, '1'],
    });
  });

  it('a window whose lease another window took stops writing, and the other takes it once A is gone ten minutes', async () => {
    const shared = testLog();
    const a = shared.log;
    const b = shared.window();
    expect(await holdLease(a, BROWSER, T0, 0)).toBe(true);
    // A closes. B watches the row unchanged for ten minutes, then takes it at the next epoch.
    expect(await holdLease(b, BROWSER, T0 + MINUTE, 0)).toBe(false);
    expect(await holdLease(b, BROWSER, T0 + 11 * MINUTE + 1, 0)).toBe(true);
    expect(shared.log.settings(LEASE_ROW)!.values.lease!.value).toEqual({
      strings: [BROWSER, '2'],
    });
    // A, back within its 120 s by its own clock, reads a row naming its device at an epoch it didn't take.
    expect(stillHeld(a, BROWSER, T0 + 60_000)).toBe(false);
  });

  it('is taken at once when it names nobody, and let go after 120 s without a renewal', async () => {
    const shared = testLog();
    expect(await holdLease(shared.log, BROWSER, T0, 0)).toBe(true);
    expect(stillHeld(shared.log, BROWSER, T0 + 119_000)).toBe(true);
    expect(stillHeld(shared.log, BROWSER, T0 + 120_000)).toBe(false);
    expect(await holdLease(shared.log, BROWSER, T0 + 121_000, 0)).toBe(false);
  });

  it('a lease another device took is let go at once, inside the 120 s', async () => {
    const shared = testLog();
    expect(await holdLease(shared.log, BROWSER, T0, 0)).toBe(true);
    shared.land(leaseRow(TV, 7));
    expect(stillHeld(shared.log, BROWSER, T0 + 1_000)).toBe(false);
    expect(await holdLease(shared.log, BROWSER, T0 + 61_000, 0)).toBe(false);
  });
});
