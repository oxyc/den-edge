import { describe, expect, it } from 'vitest';
import type { ClockStore } from './clockStore';
import { DownloadCoordinator, downloadIsInFlight, downloadPollDelay } from './downloadCoordinator';
import { DownloadCoordinatorDriver } from './downloadCoordinatorDriver';
import { clockValue, downloadName, readDownload, releaseValue, titleValue } from './downloadRows';
import { source, testLog } from './downloadTestLog';
import type { Preparation } from './titleSources';
import type { SettingsRow, Stamp } from './wire';

const DEVICE = 'bbbbbbbbbbbbbbbb';
const TV = 'aaaaaaaaaaaaaaaa';
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const NAME = downloadName('tv:1399:2:3');

const title = {
  mediaType: 'tv' as const,
  mediaId: 1399,
  imdbId: 'tt1',
  season: 2,
  episode: 3,
  title: 'Rebecka Martinsson',
};

const first = source('Rebecka.S02E03.2160p.WEB-DL.mkv', {
  resolution: '2160p',
  cached: false,
  seeders: 20,
});
const second = source('Rebecka.S02E03.1080p.WEB-DL.mkv', {
  resolution: '1080p',
  cached: false,
  seeders: 20,
});

function clock(options: { gate?: Promise<void>; issued?: Stamp[] } = {}): ClockStore {
  let last: Stamp = [0, 0, DEVICE];
  return {
    device: DEVICE,
    async issue(now = Date.now()) {
      await options.gate;
      last = now > last[0] ? [now, 0, DEVICE] : [last[0], last[1] + 1, DEVICE];
      options.issued?.push([...last]);
      return [...last];
    },
    async historical(times) {
      return times.map((at) => [at, ++last[1], DEVICE]);
    },
    async see(stamp) {
      if (stamp[0] > last[0] || (stamp[0] === last[0] && stamp[1] > last[1]))
        last = [stamp[0], stamp[1], DEVICE];
    },
    async current() {
      return [...last];
    },
  };
}

function effects(asked: string[] = []) {
  return {
    prepare: async (url: string, queue: boolean, prefetch: boolean) => {
      asked.push(`${queue ? (prefetch ? 'prefetch' : 'add') : 'probe'} ${url}`);
      return { state: 'preparing' as const, progress: 0 };
    },
    cancel: async () => true,
    resolve: async () => ({ sources: [first, second] }),
    ticket: (url: string) => (url.startsWith('/scout/') ? url : null),
  };
}

function stalledRow(): SettingsRow {
  const at: Stamp = [T0, 0, TV];
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
      title: { value: titleValue(title), at },
      queuedAt: { value: { int: T0 }, at },
      progress: { value: clockValue({ lastProgress: 0, progressAt: T0 }), at },
    },
  };
}

describe('DownloadCoordinator', () => {
  it('has the same bounded polling backoff without page state', () => {
    expect(downloadPollDelay(0)).toBe(5_000);
    expect(downloadPollDelay(3)).toBe(40_000);
    expect(downloadPollDelay(20)).toBe(60_000);
  });

  it('treats paused and not-yet-started work as cancellable upstream', () => {
    expect(downloadIsInFlight('paused')).toBe(true);
    expect(downloadIsInFlight('not_started')).toBe(true);
    expect(downloadIsInFlight('ready')).toBe(false);
  });

  it('does not write until its durable asynchronous stamp has committed', async () => {
    const shared = testLog();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const queue = new DownloadCoordinator(shared.log, clock({ gate }), effects(), {
      now: () => T0,
    });

    const starting = queue.enqueue(title, first, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(shared.writes).toEqual([]);

    release();
    await expect(starting).resolves.toBe(true);
    expect(readDownload(shared.log.settings(NAME)!)!).toMatchObject({
      release: { identity: first.identity },
      queuedBy: DEVICE,
      candidates: 2,
    });
  });

  it('acknowledges the durable enqueue without waiting on Scout activation', async () => {
    const shared = testLog();
    let release!: () => void;
    const activated = new Promise<void>((resolve) => (release = resolve));
    let changes = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async () => {
          await activated;
          return { state: 'preparing', progress: 0.2 };
        },
      },
      { now: () => T0, changed: () => changes++ },
    );

    await expect(queue.enqueue(title, first, 1)).resolves.toBe(true);
    expect(shared.log.settings(NAME)).toBeDefined();
    expect(changes).toBe(1);

    release();
    await activated;
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.answers.get(NAME)).toMatchObject({ state: 'preparing', progress: 0.2 });
    expect(changes).toBe(2);
  });

  it('keeps one worker-owned source snapshot for display and selection', async () => {
    const shared = testLog();
    let resolves = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => {
          resolves++;
          return { sources: [first, second] };
        },
      },
      { now: () => T0 },
    );

    const shown = await queue.sourcesForTitle(title);
    expect(shown.sources?.map(({ identity }) => identity)).toEqual([
      first.identity,
      second.identity,
    ]);
    await expect(queue.enqueueIdentity(title, first.identity, 2)).resolves.toBe(true);
    expect(resolves).toBe(1);

    await queue.sourcesForTitle(title, true);
    expect(resolves).toBe(2);
  });

  it('downloads Rebecka Martinsson S02E01 as an uncached 1080p, not the cached SD AVI', async () => {
    const avi = source('Rebecka.Martinsson.S02E01.SWEDiSH.PDTV.XviD-GRP.avi', {
      resolution: '480p',
      cached: true,
      seeders: 3,
    });
    const h264 = source('Rebecka.Martinsson.S02E01.1080p.WEB.H264-GRP.mkv', {
      resolution: '1080p',
      codec: 'h264',
      cached: false,
      seeders: 12,
    });
    const hevc = source('Rebecka.Martinsson.S02E01.1080p.WEB.H265-GRP.mkv', {
      resolution: '1080p',
      codec: 'hevc',
      cached: false,
      seeders: 9,
    });
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      { ...effects(), resolve: async () => ({ sources: [avi, h264, hevc] }) },
      { now: () => T0 },
    );

    expect(queue.pick([avi, h264, hevc], 'sv')?.identity).toBe(h264.identity);
    const shown = await queue.sourcesForTitle({ ...title, episode: 1, originalLanguage: 'sv' });
    expect(shown.sources?.[0]?.identity).toBe(h264.identity);
  });

  it('sinks an AVI for a download by its file name when its identity is an info-hash', () => {
    const avi = source(
      'Rebecka.Martinsson.S02E03.1080p.HDTV.avi',
      { resolution: '1080p', cached: true, seeders: 20 },
      '5d41402abc4b2a76b9719d911017c592aa000001',
    );
    const mkv = source(
      'Rebecka.Martinsson.S02E03.720p.HDTV.x264.mkv',
      { resolution: '720p', codec: 'h264', cached: false, seeders: 20 },
      '5d41402abc4b2a76b9719d911017c592aa000002',
    );
    const queue = new DownloadCoordinator(testLog().log, clock(), effects(), { now: () => T0 });
    expect(avi.identity).toBe('5d41402abc4b2a76b9719d911017c592aa000001');
    expect(queue.pick([avi, mkv])?.identity).toBe(mkv.identity);
  });

  it('coalesces concurrent fresh UI, renewal, hedge, and fallback source resolution', async () => {
    const shared = testLog([stalledRow()]);
    let resolves = 0;
    let releaseFresh!: () => void;
    let announceFresh!: () => void;
    const freshGate = new Promise<void>((resolve) => (releaseFresh = resolve));
    const freshStarted = new Promise<void>((resolve) => (announceFresh = resolve));
    let fresh = false;
    const refreshedFirst = { ...first, url: '/scout/p/fresh-primary' };
    const refreshedSecond = { ...second, url: '/scout/p/fresh-hedge' };
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => {
          resolves++;
          if (fresh) {
            announceFresh();
            await freshGate;
          }
          return { sources: fresh ? [refreshedFirst, refreshedSecond] : [first, second] };
        },
      },
      { now: () => T0 + 21 * MINUTE, monotonicNow: () => 0 },
    );

    await queue.sourcesForTitle(title);
    expect(resolves).toBe(1);
    fresh = true;
    const download = queue.get(NAME)!;
    const entry = { identity: second.identity, url: '/foreign/expired-hedge-ticket', queuedAt: T0 };
    const hedged = { ...download, race: { ...download.race, entries: [entry] } };
    const fallback = new DownloadCoordinatorDriver(queue).run({
      now: T0 + 21 * MINUTE,
      observedFor: 0,
    });
    await freshStarted;
    expect(resolves).toBe(2);
    const shown = queue.sourcesForTitle(title, true);
    const renewed = queue.renew(download);
    const hedge = queue.renewEntryUrl(hedged, entry);

    releaseFresh();
    await expect(shown).resolves.toMatchObject({ sources: [refreshedFirst, refreshedSecond] });
    await expect(renewed).resolves.toBe(refreshedFirst.url);
    await expect(hedge).resolves.toBe(refreshedSecond.url);
    await expect(fallback).resolves.toBe(true);
    expect(resolves).toBe(2);
  });

  it('does not reactivate an already queued release', async () => {
    const shared = testLog();
    const asked: string[] = [];
    const queue = new DownloadCoordinator(shared.log, clock(), effects(asked), { now: () => T0 });
    await queue.enqueue(title, first, 2);
    await Promise.resolve();
    await queue.enqueue(title, first, 2);
    await Promise.resolve();
    expect(shared.writes).toHaveLength(1);
    expect(asked).toEqual([`prefetch ${first.url}`]);
  });

  it('cancels a paused upstream fetch when removing it', async () => {
    const shared = testLog();
    const cancelled: string[] = [];
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async () => ({ state: 'paused', until: T0 + MINUTE }),
        cancel: async (url) => {
          cancelled.push(url);
          return true;
        },
      },
      { now: () => T0 },
    );
    await queue.enqueue(title, first, 1);
    await Promise.resolve();
    const download = queue.get(NAME)!;
    expect(queue.status(download).state).toBe('paused');
    await queue.remove(download, true);
    expect(cancelled).toEqual([first.url]);
  });

  it('moves a download whose release is no longer listed on to the next release', async () => {
    const shared = testLog([stalledRow()]);
    const asked: string[] = [];
    // The row's ticket lapsed, and the fresh list no longer carries its release.
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(asked),
        prepare: async (url: string, queue: boolean, prefetch: boolean) => {
          asked.push(`${queue ? (prefetch ? 'prefetch' : 'add') : 'probe'} ${url}`);
          return url === first.url
            ? { state: 'expired' as const }
            : { state: 'preparing' as const, progress: 0 };
        },
        resolve: async () => ({ sources: [second] }),
      },
      { now: () => T0 + MINUTE, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);

    await expect(driver.run({ now: T0 + MINUTE, observedFor: 0 })).resolves.toBe(true);

    const moved = readDownload(shared.log.settings(NAME)!)!;
    expect(moved.release.identity).toBe(second.identity);
    expect(moved.tried).toEqual([first.identity]);
    expect(moved.exhausted).toBe(false);
    expect(asked).toEqual([`probe ${first.url}`, `prefetch ${second.url}`]);
  });

  it('keeps searching for a wanted episode, backing off, until a release turns up', async () => {
    const shared = testLog();
    const asked: string[] = [];
    let now = T0;
    let listed: (typeof first)[] = [];
    let resolves = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(asked),
        resolve: async () => {
          resolves++;
          return { sources: listed };
        },
      },
      { now: () => now, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    // The service scheduler runs the driver every few seconds, renewing the lease; step time as it does.
    const run = async (at: number) => {
      do {
        now = Math.min(at, now + 30_000);
        await driver.run({ now, observedFor: 0 });
      } while (now < at);
    };

    await expect(queue.want(title)).resolves.toBe(true);
    const wanted = queue.get(NAME)!;
    expect(wanted).toMatchObject({ wanted: true, exhausted: true, retries: 0 });
    const firstSearch = queue.status(wanted, now).until!;
    expect(queue.status(wanted, now).state).toBe('no_working_release');
    expect(firstSearch - T0).toBeGreaterThanOrEqual(12 * MINUTE);
    expect(firstSearch - T0).toBeLessThanOrEqual(18 * MINUTE);

    // Before its time nothing is asked.
    await run(T0 + MINUTE);
    expect(resolves).toBe(0);

    // Due, and still nothing listed: a fresh `exhausted`, one more search counted, and a longer wait.
    await run(firstSearch);
    expect(resolves).toBe(1);
    const searched = queue.get(NAME)!;
    expect(searched).toMatchObject({ wanted: true, exhausted: true, retries: 1 });
    const secondSearch = queue.status(searched, now).until!;
    expect(secondSearch - firstSearch).toBeGreaterThanOrEqual(24 * MINUTE);

    // A release shows up (the pack got seeded): the next due search starts it.
    listed = [second];
    await run(secondSearch - MINUTE);
    expect(resolves).toBe(1);
    await run(secondSearch);
    const started = queue.get(NAME)!;
    expect(started).toMatchObject({ wanted: false, exhausted: false, retries: 2 });
    expect(started.release.identity).toBe(second.identity);
    expect(asked).toEqual([`prefetch ${second.url}`]);
    expect(queue.status(started, now).state).toBe('fetching');
  });

  it('waits for a wanted episode to air before searching for it', async () => {
    const shared = testLog();
    let resolves = 0;
    let now = T0;
    const airs = T0 + 6 * 60 * MINUTE;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => {
          resolves++;
          return { sources: [first] };
        },
      },
      { now: () => now, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    const run = async (at: number) => {
      do {
        now = Math.min(at, now + 30_000);
        await driver.run({ now, observedFor: 0 });
      } while (now < at);
    };
    await queue.want({ ...title, airDate: airs });
    const waiting = queue.get(NAME)!;
    expect(queue.status(waiting, T0)).toMatchObject({ state: 'awaiting_air', until: airs });

    await run(airs - MINUTE);
    expect(resolves).toBe(0);
    await run(airs);
    expect(resolves).toBe(1);
    expect(queue.get(NAME)!.release.identity).toBe(first.identity);
  });

  it('asks again shortly when a due search gets no full answer', async () => {
    const shared = testLog();
    let resolves = 0;
    let now = T0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => {
          resolves++;
          return { sources: null, failure: 'unreachable' as const };
        },
      },
      { now: () => now, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    const run = async (at: number) => {
      do {
        now = Math.min(at, now + 30_000);
        await driver.run({ now, observedFor: 0 });
      } while (now < at);
    };
    await queue.want(title);
    const due = queue.status(queue.get(NAME)!, T0).until!;
    await run(due);
    expect(resolves).toBe(1);
    // Nothing written: the row's schedule is untouched, and the next passes don't hammer the addon.
    expect(queue.get(NAME)).toMatchObject({ retries: 0, exhausted: true });
    await run(due + 4 * MINUTE);
    expect(resolves).toBe(1);
    await run(due + 5 * MINUTE);
    expect(resolves).toBe(2);
  });

  describe('the race (§17 Racing), Rebecka Martinsson S02E01 with nothing good cached', () => {
    const episode = { ...title, episode: 1, originalLanguage: 'sv' };
    const EPISODE = downloadName('tv:1399:2:1');
    const avi = source('Rebecka.Martinsson.S02E01.400p.WEB-DLRip.avi', {
      resolution: '480p',
      cached: true,
      seeders: 3,
      sizeBytes: 700_000_000,
    });
    const a = source('Rebecka.Martinsson.S02E01.1080p.WEB.H264-A.mkv', {
      resolution: '1080p',
      codec: 'h264',
      cached: false,
      seeders: 12,
      sizeBytes: 3_000_000_000,
    });
    const b = source('Rebecka.Martinsson.S02E01.1080p.WEB.H265-B.mkv', {
      resolution: '1080p',
      codec: 'hevc',
      cached: false,
      seeders: 6,
      sizeBytes: 2_000_000_000,
    });
    const c = source('Rebecka.Martinsson.S02E01.720p.HDTV.H264-C.mkv', {
      resolution: '720p',
      codec: 'h264',
      cached: false,
      seeders: 4,
      sizeBytes: 1_200_000_000,
    });

    /** A queue whose den-scout answers each ticket as `answers` says (a stall by default), recording every ask. */
    function racing(answers: Record<string, Preparation> = {}, asked: string[] = []) {
      const shared = testLog();
      let now = T0;
      const queue = new DownloadCoordinator(
        shared.log,
        clock(),
        {
          prepare: async (url: string, queue: boolean, prefetch: boolean) => {
            asked.push(`${queue ? (prefetch ? 'prefetch' : 'add') : 'probe'} ${url}`);
            return answers[url] ?? { state: 'preparing', progress: 0, bytesPerSecond: 0 };
          },
          cancel: async (url: string) => {
            asked.push(`cancel ${url}`);
            return true;
          },
          resolve: async () => ({ sources: [avi, a, b, c] }),
          ticket: (url: string) => (url.startsWith('/scout/') ? url : null),
        },
        { now: () => now, monotonicNow: () => 0 },
      );
      const driver = new DownloadCoordinatorDriver(queue);
      /** Passes every 30 s up to `at`, as the service scheduler runs them. */
      const run = async (at: number) => {
        do {
          now = Math.min(at, now + 30_000);
          await driver.run({ now, observedFor: 0 });
        } while (now < at);
      };
      return { shared, queue, run, asked };
    }

    it('a stalled 1080p races the next two, and the cached AVI is not taken', async () => {
      const { shared, queue, run, asked } = racing();
      await queue.enqueue(episode, queue.pick([avi, a, b, c], 'sv')!, 4);
      expect(readDownload(shared.log.settings(EPISODE)!)!.release.identity).toBe(a.identity);

      await run(T0 + 21 * MINUTE);

      const row = readDownload(shared.log.settings(EPISODE)!)!;
      expect(row.release.identity).toBe(a.identity);
      expect(row.race.entries.map(({ identity }) => identity)).toEqual([b.identity, c.identity]);
      expect(row.race.stage).toBe(1);
      expect(asked).toContain(`prefetch ${b.url}`);
      expect(asked).toContain(`prefetch ${c.url}`);
      expect(asked).not.toContain(`prefetch ${avi.url}`);
      expect(asked.filter((ask) => ask.startsWith('cancel'))).toEqual([]);
    });

    it('the first release to finish is kept and the others are cancelled', async () => {
      const answers: Record<string, Preparation> = {};
      const { shared, queue, run, asked } = racing(answers);
      await queue.enqueue(episode, a, 4);
      await run(T0 + 21 * MINUTE);
      answers[c.url] = { state: 'ready' };
      await run(T0 + 23 * MINUTE);

      const row = readDownload(shared.log.settings(EPISODE)!)!;
      expect(row.release.identity).toBe(c.identity);
      expect(row.race.entries).toEqual([]);
      expect(asked).toContain(`cancel ${a.url}`);
      expect(asked).toContain(`cancel ${b.url}`);
      expect(asked).not.toContain(`cancel ${c.url}`);
    });

    it('a day with nothing watchable takes the cached AVI rather than wait', async () => {
      const { shared, queue, run } = racing();
      await queue.enqueue(episode, a, 4);
      await run(T0 + 23 * 60 * MINUTE);
      expect(readDownload(shared.log.settings(EPISODE)!)!.release.identity).not.toBe(avi.identity);
      await run(T0 + 24 * 60 * MINUTE + MINUTE);
      expect(readDownload(shared.log.settings(EPISODE)!)!.release.identity).toBe(avi.identity);
    });

    it('a refused add is the debrid’s active limit: the race holds, and nothing is counted as failed', async () => {
      const answers: Record<string, Preparation> = {
        [c.url]: { state: 'refused', service: 'torbox' },
      };
      const { shared, queue, run } = racing(answers);
      await queue.enqueue(episode, a, 4);
      await run(T0 + 21 * MINUTE);
      const row = readDownload(shared.log.settings(EPISODE)!)!;
      expect(row.race.entries.map(({ identity }) => identity)).toEqual([b.identity]);
      expect(row.race.cappedAt).toBeGreaterThanOrEqual(T0 + 20 * MINUTE);
      expect(row.tried).toEqual([]);
    });
  });

  it('uses durable stamps for the lease and every race write', async () => {
    const shared = testLog([stalledRow()]);
    const issued: Stamp[] = [];
    const asked: string[] = [];
    const queue = new DownloadCoordinator(shared.log, clock({ issued }), effects(asked), {
      now: () => T0 + 21 * MINUTE,
      monotonicNow: () => 0,
    });
    const driver = new DownloadCoordinatorDriver(queue);

    await expect(driver.run({ now: T0 + 21 * MINUTE, observedFor: 0 })).resolves.toBe(true);

    // A stalled download is not given up on: the next release races beside it (§17 *Racing*).
    const raced = readDownload(shared.log.settings(NAME)!)!;
    expect(raced.release.identity).toBe(first.identity);
    expect(raced.race.entries.map(({ identity }) => identity)).toEqual([second.identity]);
    expect(raced.race.stage).toBe(1);
    expect(raced.tried).toEqual([]);
    expect(asked).toEqual([`probe ${first.url}`, `prefetch ${second.url}`]);
    expect(issued.length).toBeGreaterThanOrEqual(2);
    expect(issued.every((stamp) => stamp[2] === DEVICE)).toBe(true);
  });
});
