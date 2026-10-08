import { describe, expect, it } from 'vitest';
import type { ClockStore } from './clockStore';
import { DownloadCoordinator, downloadIsInFlight, downloadPollDelay } from './downloadCoordinator';
import { DownloadCoordinatorDriver } from './downloadCoordinatorDriver';
import { clockValue, downloadName, readDownload, releaseValue, titleValue } from './downloadRows';
import { source, testLog } from './downloadTestLog';
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
    const hedged = {
      ...download,
      release: {
        ...download.release,
        hedge: {
          identity: second.identity,
          url: '/foreign/expired-hedge-ticket',
          queuedAt: T0,
          lastProgress: 0,
          progressAt: T0,
        },
      },
    };
    const fallback = new DownloadCoordinatorDriver(queue).run({
      now: T0 + 21 * MINUTE,
      observedFor: 0,
    });
    await freshStarted;
    expect(resolves).toBe(2);
    const shown = queue.sourcesForTitle(title, true);
    const renewed = queue.renew(download);
    const hedge = queue.hedgeUrl(hedged);

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

  it('uses durable stamps for the lease and every fallback write', async () => {
    const shared = testLog([stalledRow()]);
    const issued: Stamp[] = [];
    const asked: string[] = [];
    const queue = new DownloadCoordinator(shared.log, clock({ issued }), effects(asked), {
      now: () => T0 + 21 * MINUTE,
      monotonicNow: () => 0,
    });
    const driver = new DownloadCoordinatorDriver(queue);

    await expect(driver.run({ now: T0 + 21 * MINUTE, observedFor: 0 })).resolves.toBe(true);

    const moved = readDownload(shared.log.settings(NAME)!)!;
    expect(moved.release.identity).toBe(second.identity);
    expect(moved.tried).toEqual([first.identity]);
    expect(asked).toEqual([`probe ${first.url}`, `prefetch ${second.url}`]);
    expect(issued.length).toBeGreaterThanOrEqual(2);
    expect(issued.every((stamp) => stamp[2] === DEVICE)).toBe(true);
  });
});
