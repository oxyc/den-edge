import { describe, expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import {
  DOWNLOAD_ENTRY_RECOVERY_MS,
  DownloadCoordinator,
  downloadDiagnostic,
  downloadPollDelay,
} from './downloadCoordinator';
import { DownloadCoordinatorDriver } from './downloadCoordinatorDriver';
import {
  clockValue,
  downloadName,
  LEASE_ROW,
  raceValue,
  readDownload,
  releaseValue,
  removedRow,
  titleValue,
  withValues,
  type DownloadTitle,
} from './downloadRows';
import { source, testLog } from './downloadTestLog';
import type { Preparation } from './titleSources';
import type { DocumentRow, SettingsRow, Stamp } from './wire';

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

function clock(
  options: { gate?: Promise<void>; issued?: Stamp[]; starting?: () => void } = {},
): ClockStore {
  let last: Stamp = [0, 0, DEVICE];
  return {
    device: DEVICE,
    async issue(now = Date.now()) {
      options.starting?.();
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

function racedRow(
  raceTitle: DownloadTitle,
  primary = first,
  entry = { ...second, url: '/scout/p/expired-race-ticket' },
): SettingsRow {
  const at: Stamp = [T0, 0, TV];
  const name = downloadName(
    `${raceTitle.mediaType}:${raceTitle.mediaId}:${raceTitle.season ?? -1}:${raceTitle.episode ?? -1}`,
  );
  return withValues(
    {
      kind: 'set',
      schema: 2,
      name,
      values: {
        release: {
          value: releaseValue({
            identity: primary.identity,
            label: primary.label,
            url: primary.url,
          }),
          at,
        },
        title: { value: titleValue(raceTitle), at },
        queuedAt: { value: { int: T0 }, at },
        progress: { value: clockValue({ lastProgress: 0, progressAt: T0 }), at },
      },
    },
    {
      race: {
        value: raceValue({
          stage: 1,
          stageAt: T0,
          startedAt: T0,
          entries: [
            {
              identity: entry.identity,
              label: entry.label,
              url: entry.url,
              queuedAt: T0,
            },
          ],
        }),
        at,
      },
    },
  );
}

describe('DownloadCoordinator', () => {
  it('emits only fixed privacy-safe download diagnostic codes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    for (let code = 1; code <= 11; code++) downloadDiagnostic(code);

    expect(warn.mock.calls).toEqual([
      ['den: download', 1],
      ['den: download', 2],
      ['den: download', 3],
    ]);
    expect(info.mock.calls).toEqual(
      Array.from({ length: 8 }, (_, index) => ['den: download', index + 4]),
    );
    warn.mockRestore();
    info.mockRestore();
  });

  it('has the same bounded polling backoff without page state', () => {
    expect(downloadPollDelay(0)).toBe(5_000);
    expect(downloadPollDelay(3)).toBe(40_000);
    expect(downloadPollDelay(20)).toBe(60_000);
  });

  it.each([
    {
      label: 'movie /scout',
      exact: {
        mediaType: 'movie' as const,
        mediaId: 44,
        imdbId: 'tt0044',
        title: 'Movie',
      },
      stale: '/scout/p/expired-movie-ticket',
    },
    {
      label: 'episode /den',
      exact: title,
      stale: '/den/p/expired-episode-ticket',
    },
  ])(
    'renews an expired persisted $label ticket by exact content and file identity',
    async ({ exact, stale }) => {
      const persisted = { ...second, url: stale };
      const fresh = { ...second, url: `${stale}-fresh` };
      const shared = testLog([racedRow(exact, first, persisted)]);
      const prepared: string[] = [];
      const resolved: DownloadTitle[] = [];
      const queue = new DownloadCoordinator(
        shared.log,
        clock(),
        {
          ...effects(),
          ticket: (url) => (/^\/(?:scout|den)\//.test(url) ? url : null),
          prepare: async (url) => {
            prepared.push(url);
            return url === stale ? { state: 'expired' } : { state: 'ready' };
          },
          resolve: async (asked) => {
            resolved.push(asked);
            return { sources: [fresh], answer: { kind: 'live', missing: 0 } };
          },
        },
        { now: () => T0 + MINUTE },
      );
      const download = queue.list()[0]!;
      const entry = download.race.entries[0]!;

      await expect(queue.pollEntry(download, entry)).resolves.toMatchObject({ state: 'ready' });

      expect(resolved).toEqual([exact]);
      expect(prepared).toEqual([stale, fresh.url]);
      expect(queue.entryUrl(download, entry)).toBe(fresh.url);
      expect(entry.identity).toBe(fresh.identity);
    },
  );

  it('holds an incomplete expired-ticket renewal for 60 seconds, then recovers without reusing the stale URL', async () => {
    let now = T0 + MINUTE;
    let complete = false;
    const stale = '/scout/p/expired-race-ticket';
    const fresh = { ...second, url: '/scout/p/eventual-race-ticket' };
    const shared = testLog([racedRow(title, first, { ...second, url: stale })]);
    const prepared: string[] = [];
    let resolves = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async (url) => {
          prepared.push(url);
          return url === fresh.url ? { state: 'ready' } : { state: 'expired' };
        },
        resolve: async () => {
          resolves++;
          return complete
            ? { sources: [fresh], answer: { kind: 'live' as const, missing: 0 } }
            : { sources: [fresh], answer: { kind: 'partial' as const, missing: 1 } };
        },
      },
      { now: () => now },
    );
    const download = queue.list()[0]!;
    const entry = download.race.entries[0]!;

    await expect(queue.pollEntry(download, entry, { now })).resolves.toBeUndefined();
    await expect(queue.pollEntry(download, entry, { now: now + 10_000 })).resolves.toBeUndefined();
    expect(resolves).toBe(1);
    expect(prepared).toEqual([stale]);

    complete = true;
    now += DOWNLOAD_ENTRY_RECOVERY_MS + 1;
    await expect(queue.pollEntry(download, entry, { now })).resolves.toMatchObject({
      state: 'ready',
    });
    expect(resolves).toBe(2);
    expect(prepared).toEqual([stale, fresh.url]);
  });

  it('holds an incomplete renewal despite a stale race list, then recovers after 60 seconds', async () => {
    let now = T0 + 21 * MINUTE;
    const stale = '/scout/p/expired-scheduled-ticket';
    const fresh = { ...second, url: '/scout/p/renewed-scheduled-ticket' };
    const shared = testLog([racedRow(title, first, { ...second, url: stale })]);
    let expired = false;
    let complete = true;
    let resolves = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async (url) =>
          url === stale && expired
            ? { state: 'expired' }
            : url === fresh.url
              ? { state: 'ready' }
              : { state: 'preparing', progress: 0 },
        resolve: async () => {
          resolves++;
          return complete
            ? { sources: [first, fresh], answer: { kind: 'live' as const, missing: 0 } }
            : { sources: [fresh], answer: { kind: 'partial' as const, missing: 1 } };
        },
      },
      { now: () => now, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);

    // Populate the driver's ten-minute race list with an ordinary complete pass.
    await driver.run({ now, observedFor: 0 });
    expect(resolves).toBe(1);

    now += 11 * MINUTE;
    expired = true;
    complete = false;
    await driver.run({ now, observedFor: 0 });
    expect(resolves).toBe(2);
    expect(readDownload(shared.log.settings(NAME)!)!.race.entries[0]?.url).toBe(stale);

    now += 10_000;
    await driver.run({ now, observedFor: 0 });
    expect(resolves).toBe(2);

    now += DOWNLOAD_ENTRY_RECOVERY_MS - 10_000 + 1;
    complete = true;
    await driver.run({ now, observedFor: 0 });
    expect(resolves).toBe(4);
    expect(readDownload(shared.log.settings(NAME)!)!.release).toMatchObject({
      identity: fresh.identity,
      url: fresh.url,
    });
  });

  it('does not publish a race winner after profile replacement during the late list resolve', async () => {
    const now = T0 + 21 * MINUTE;
    const shared = testLog([racedRow(title)]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resolving = new Promise<void>((resolve) => (started = resolve));
    let current = true;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async (url) =>
          url === second.url || url.includes('expired-race-ticket')
            ? { state: 'ready' }
            : { state: 'preparing', progress: 0 },
        resolve: async () => {
          started();
          await gate;
          return { sources: [first, second], answer: { kind: 'live', missing: 0 } };
        },
      },
      { now: () => now, monotonicNow: () => 0 },
    );

    const running = new DownloadCoordinatorDriver(queue).run({
      now,
      observedFor: 0,
      current: () => current,
    });
    await resolving;
    current = false;
    release();
    await expect(running).resolves.toBe(false);

    const kept = readDownload(shared.log.settings(NAME)!)!;
    expect(kept.release.identity).toBe(first.identity);
    expect(kept.race.entries).toHaveLength(1);
    expect(shared.writes.filter((write) => write === `writeAt set:${NAME}`)).toEqual([]);
  });

  it('does not acquire a lease after profile replacement during the durable stamp', async () => {
    const shared = testLog([stalledRow()]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const issuing = new Promise<void>((resolve) => (started = resolve));
    let current = true;
    const queue = new DownloadCoordinator(
      shared.log,
      clock({ gate, starting: () => started() }),
      effects(),
      { now: () => T0 + MINUTE, monotonicNow: () => 0 },
    );

    const running = new DownloadCoordinatorDriver(queue).run({
      now: T0 + MINUTE,
      observedFor: 0,
      current: () => current,
    });
    await issuing;
    current = false;
    release();

    await expect(running).resolves.toBe(false);
    expect(shared.log.settings(LEASE_ROW)).toBeUndefined();
    expect(shared.writes).toEqual([]);
  });

  it('does not acquire a lease after another holder takes it during the durable stamp', async () => {
    const shared = testLog([stalledRow()]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const issuing = new Promise<void>((resolve) => (started = resolve));
    const queue = new DownloadCoordinator(
      shared.log,
      clock({ gate, starting: () => started() }),
      effects(),
      { now: () => T0 + MINUTE, monotonicNow: () => 0 },
    );
    const running = new DownloadCoordinatorDriver(queue).run({
      now: T0 + MINUTE,
      observedFor: 0,
    });

    await issuing;
    shared.land({
      kind: 'set',
      schema: 2,
      name: LEASE_ROW,
      values: {
        lease: { value: { strings: [TV, '1'] }, at: [T0 + MINUTE, 0, TV] },
      },
    });
    release();

    await expect(running).resolves.toBe(false);
    expect(shared.log.settings(LEASE_ROW)?.values.lease?.value).toEqual({ strings: [TV, '1'] });
    expect(shared.writes).toEqual([]);
  });

  it('does not prune a watched download after losing the lease during its durable stamp', async () => {
    const now = T0 + 3 * 24 * 60 * MINUTE;
    const announced = withValues(stalledRow(), {
      announced: { value: { bool: true }, at: [T0, 1, TV] },
    });
    const shared = testLog([announced]);
    const watched: DocumentRow = {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: title.mediaId },
      season: title.season,
      seasonReset: null,
      episodes: {
        [title.episode]: {
          progress: { value: 1, at: [T0 + MINUTE, 0, TV], viewing: 0 },
          imported: false,
          plays: {},
          cleared: null,
        },
      },
    };
    shared.log.documentNamed = (name) =>
      name === `season:tv:${title.mediaId}:${title.season}` ? watched : undefined;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const issuing = new Promise<void>((resolve) => (started = resolve));
    const baseClock = clock();
    let issues = 0;
    const heldClock: ClockStore = {
      ...baseClock,
      async issue(at) {
        if (++issues === 2) {
          started();
          await gate;
        }
        return baseClock.issue(at);
      },
    };
    const queue = new DownloadCoordinator(
      shared.log,
      heldClock,
      { ...effects(), prepare: async () => ({ state: 'ready' }) },
      { now: () => now, monotonicNow: () => 0 },
    );
    const running = new DownloadCoordinatorDriver(queue).run({ now, observedFor: 0 });

    await issuing;
    const lease = shared.log.settings(LEASE_ROW)!;
    shared.land({
      ...lease,
      values: {
        ...lease.values,
        lease: { value: { strings: [TV, '999'] }, at: [now + 1, 0, TV] },
      },
    });
    release();

    await expect(running).resolves.toBe(false);
    expect(readDownload(shared.log.settings(NAME)!)?.release.identity).toBe(first.identity);
    expect(shared.writes.filter((write) => write === `writeAt set:${NAME}`)).toEqual([]);
  });

  it('publishes an exactly renewed winner by CAS and reads its fresh ticket back durably', async () => {
    const now = T0 + 21 * MINUTE;
    const stale = '/scout/p/expired-winning-ticket';
    const fresh = { ...second, url: '/scout/p/fresh-winning-ticket' };
    const shared = testLog([racedRow(title, first, { ...second, url: stale })]);
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async (url) =>
          url === stale
            ? { state: 'expired' }
            : url === fresh.url
              ? { state: 'ready' }
              : { state: 'preparing', progress: 0 },
        resolve: async () => ({
          sources: [first, fresh],
          answer: { kind: 'live', missing: 0 },
        }),
      },
      { now: () => now, monotonicNow: () => 0 },
    );

    await expect(new DownloadCoordinatorDriver(queue).run({ now, observedFor: 0 })).resolves.toBe(
      true,
    );

    const won = readDownload(shared.log.settings(NAME)!)!;
    expect(won.release).toMatchObject({ identity: fresh.identity, url: fresh.url });
    expect(won.race.entries).toEqual([]);
    expect(shared.writes.filter((write) => write === `writeAt set:${NAME}`)).toHaveLength(1);

    const reopened = new DownloadCoordinator(shared.window(), clock(), effects());
    expect(reopened.get(NAME)?.release).toMatchObject({
      identity: fresh.identity,
      url: fresh.url,
    });
  });

  it('keeps the durable race receipt on CAS loss while later probes use only the renewed ticket', async () => {
    const now = T0 + 21 * MINUTE;
    const stale = '/scout/p/expired-cas-ticket';
    const fresh = { ...second, url: '/scout/p/fresh-cas-ticket' };
    const shared = testLog([racedRow(title, first, { ...second, url: stale })]);
    const writeAt = shared.log.writeAt.bind(shared.log);
    shared.log.writeAt = async (row, base) => (row.name === NAME ? false : writeAt(row, base));
    const prepared: string[] = [];
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async (url) => {
          prepared.push(url);
          return url === stale
            ? { state: 'expired' }
            : url === fresh.url
              ? { state: 'ready' }
              : { state: 'preparing', progress: 0 };
        },
        resolve: async () => ({
          sources: [first, fresh],
          answer: { kind: 'live', missing: 0 },
        }),
      },
      { now: () => now, monotonicNow: () => 0 },
    );

    await new DownloadCoordinatorDriver(queue).run({ now, observedFor: 0 });

    const kept = readDownload(shared.log.settings(NAME)!)!;
    const entry = kept.race.entries[0]!;
    expect(kept.release.identity).toBe(first.identity);
    expect(entry).toMatchObject({ identity: fresh.identity, url: stale });
    expect(queue.entryUrl(kept, entry)).toBe(fresh.url);
    await queue.pollEntry(kept, entry, { now: now + 10_000 });
    expect(prepared.filter((url) => url === stale)).toHaveLength(1);
    expect(prepared.at(-1)).toBe(fresh.url);
  });

  it('drops a late renewal after profile replacement', async () => {
    const shared = testLog([racedRow(title)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let current = true;
    const prepared: string[] = [];
    const fresh = { ...second, url: '/scout/p/late-race-ticket' };
    const queue = new DownloadCoordinator(shared.log, clock(), {
      ...effects(),
      prepare: async (url) => {
        prepared.push(url);
        return { state: 'expired' };
      },
      resolve: async () => {
        await gate;
        return { sources: [fresh], answer: { kind: 'live', missing: 0 } };
      },
    });
    const download = queue.list()[0]!;
    const entry = download.race.entries[0]!;
    const polling = queue.pollEntry(download, entry, { current: () => current });
    await Promise.resolve();
    await Promise.resolve();
    current = false;
    release();

    await expect(polling).resolves.toBeUndefined();
    expect(prepared).toEqual([entry.url]);
    expect(queue.entryUrl(download, entry)).toBeNull();
  });

  it('drops a late renewal after the exact durable entry is cancelled', async () => {
    const shared = testLog([racedRow(title)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const prepared: string[] = [];
    const fresh = { ...second, url: '/scout/p/cancelled-race-ticket' };
    const queue = new DownloadCoordinator(shared.log, clock(), {
      ...effects(),
      prepare: async (url) => {
        prepared.push(url);
        return { state: 'expired' };
      },
      resolve: async () => {
        await gate;
        return { sources: [fresh], answer: { kind: 'live', missing: 0 } };
      },
    });
    const download = queue.list()[0]!;
    const entry = download.race.entries[0]!;
    const polling = queue.pollEntry(download, entry);
    await Promise.resolve();
    await Promise.resolve();
    shared.land(removedRow(download.row, [T0 + MINUTE, 0, DEVICE]));
    release();

    await expect(polling).resolves.toBeUndefined();
    expect(prepared).toEqual([entry.url]);
    expect(queue.get(download.name)).toBeUndefined();
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

  it('keeps the viewer’s early list apart from the list a download decides on', async () => {
    const shared = testLog();
    const asked: boolean[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, _fresh, early) => {
          asked.push(early === true);
          if (early) {
            await held;
            return { sources: [second], answer: { kind: 'partial', missing: 0, late: 1 } };
          }
          return { sources: [first, second], answer: { kind: 'live', missing: 0 } };
        },
      },
      { now: () => T0 },
    );
    // The Sources panel's early list is still out: a download's resolve neither joins it nor reads it after.
    const shown = queue.sourcesForTitle(title, false, false, true);
    const decided = await queue.sourcesForTitle(title, true);
    expect(decided.answer?.kind).toBe('live');
    release();
    expect((await shown).answer).toMatchObject({ kind: 'partial', late: 1 });
    expect((await queue.sourcesForTitle(title)).sources?.length).toBe(2);
    expect((await queue.sourcesForTitle(title, false, false, true)).answer?.late).toBe(1);
    expect(asked).toEqual([true, false]);
  });

  it('uses den-core to retain an admitted viewer list across a failed retry', async () => {
    const shared = testLog();
    let attempt = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () =>
          attempt++ === 0
            ? {
                sources: [first],
                imdb: 'resolved',
                reply: {
                  reply: 'answered',
                  streams: 1,
                  answer: { kind: 'live', missing: 0, late: 0 },
                },
              }
            : {
                sources: null,
                imdb: 'resolved',
                reply: { reply: 'errored' },
                failure: 'unreachable',
              },
      },
      { now: () => T0 },
    );

    await expect(queue.sourcesForTitle(title, false, false, true)).resolves.toMatchObject({
      sources: [first],
      outcome: { result: 'live', list: 'new', retryable: false },
    });
    await expect(queue.sourcesForTitle(title, true, true, true)).resolves.toMatchObject({
      sources: [first],
      outcome: { result: 'failed_retryable', list: 'retained', retryable: true },
      failure: 'unreachable',
    });
  });

  it('lets only den-core confirmed empty clear a viewer list and mark absence', async () => {
    const shared = testLog();
    let attempt = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => ({
          sources: attempt++ === 0 ? [first] : [],
          imdb: 'resolved',
          reply:
            attempt === 1
              ? { reply: 'answered', streams: 1, answer: { kind: 'live', missing: 0, late: 0 } }
              : { reply: 'answered', streams: 0, answer: { kind: 'empty', missing: 0, late: 0 } },
        }),
      },
      { now: () => T0 },
    );

    await queue.sourcesForTitle(title, false, false, true);
    await expect(queue.sourcesForTitle(title, true, true, true)).resolves.toMatchObject({
      sources: [],
      outcome: {
        result: 'confirmed_empty',
        list: 'none',
        may_mark_unavailable: true,
        retryable: false,
      },
    });
  });

  it('starts a download from the list the viewer was shown, without asking again', async () => {
    const shared = testLog();
    const asked: boolean[] = [];
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, _fresh, early) => {
          asked.push(early === true);
          return { sources: [second] };
        },
      },
      { now: () => T0 },
    );
    await queue.sourcesForTitle(title, false, false, true);
    await expect(queue.enqueueIdentity(title, second.identity, 1)).resolves.toBe(true);
    expect(asked).toEqual([true]);
  });

  it('asks afresh past a plain ask in flight and fences its late result from the rebuilt snapshot', async () => {
    const shared = testLog();
    const asked: boolean[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, fresh) => {
          asked.push(fresh === true);
          if (!fresh) await held;
          return { sources: fresh ? [second] : [first], ...(fresh ? { fresh: 'rebuilt' } : {}) };
        },
      },
      { now: () => T0 },
    );
    const plain = queue.sourcesForTitle(title);
    expect((await queue.sourcesForTitle(title, false, true)).sources?.[0]?.identity).toBe(
      second.identity,
    );
    release();
    await plain;
    expect((await queue.sourcesForTitle(title)).sources?.[0]?.identity).toBe(second.identity);
    expect(asked).toEqual([false, true]);
  });

  it('keeps the per-title fresh fence after its cache entry is evicted', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let plainCalls = 0;
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      {
        ...effects(),
        resolve: async (requested, fresh) => {
          if (requested.mediaId !== title.mediaId)
            return {
              sources: [
                source(`Filler.${requested.mediaId}.mkv`, {
                  resolution: '1080p',
                  cached: true,
                }),
              ],
            };
          if (fresh) return { sources: [second], fresh: 'rebuilt' };
          if (plainCalls++ === 0) {
            await held;
            return { sources: [first] };
          }
          return { sources: [second] };
        },
      },
      { now: () => T0 },
    );

    const stale = queue.sourcesForTitle(title);
    await expect(queue.sourcesForTitle(title, false, true)).resolves.toMatchObject({
      sources: [second],
      fresh: 'rebuilt',
    });
    for (let id = 0; id < 65; id++)
      await queue.sourcesForTitle({ ...title, mediaId: 10_000 + id, imdbId: `tt${id}` });
    release();
    await expect(stale).resolves.toEqual({ sources: [first] });

    await expect(queue.sourcesForTitle(title)).resolves.toEqual({ sources: [second] });
    expect(plainCalls).toBe(2);
  });

  it.each([
    ['fresh completes first', true],
    ['plain completes first', false],
  ])(
    'keeps a rebuilt refresh authoritative when an independent plain viewer overlaps after it starts: %s',
    async (_order, freshFirst) => {
      const asked: boolean[] = [];
      let releaseFresh!: () => void;
      let releasePlain!: () => void;
      const freshHeld = new Promise<void>((resolve) => (releaseFresh = resolve));
      const plainHeld = new Promise<void>((resolve) => (releasePlain = resolve));
      const queue = new DownloadCoordinator(
        testLog().log,
        clock(),
        {
          ...effects(),
          resolve: async (_title, fresh) => {
            asked.push(fresh === true);
            await (fresh ? freshHeld : plainHeld);
            return fresh
              ? { sources: [second], fresh: 'rebuilt' }
              : { sources: [first], answer: { kind: 'live', missing: 0 } };
          },
        },
        { now: () => T0 },
      );

      const refreshed = queue.sourcesForTitle(title, false, true);
      const viewer = queue.sourcesForTitle(title);
      if (freshFirst) {
        releaseFresh();
        await expect(refreshed).resolves.toMatchObject({ sources: [second], fresh: 'rebuilt' });
        releasePlain();
        await expect(viewer).resolves.toEqual({
          sources: [first],
          answer: { kind: 'live', missing: 0 },
        });
      } else {
        releasePlain();
        await expect(viewer).resolves.toEqual({
          sources: [first],
          answer: { kind: 'live', missing: 0 },
        });
        releaseFresh();
        await expect(refreshed).resolves.toMatchObject({ sources: [second], fresh: 'rebuilt' });
      }

      expect(await queue.sourcesForTitle(title)).toEqual({ sources: [second] });
      expect(asked).toEqual([true, false]);
    },
  );

  it('publishes an admitted rebuild after a newer overlapping refresh is limited', async () => {
    const asked: boolean[] = [];
    let freshAsks = 0;
    let releaseRebuild!: () => void;
    const rebuildHeld = new Promise<void>((resolve) => (releaseRebuild = resolve));
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, fresh) => {
          asked.push(fresh === true);
          if (!fresh) return { sources: [first] };
          if (freshAsks++ === 0) {
            await rebuildHeld;
            return { sources: [second], fresh: 'rebuilt' };
          }
          return { sources: [second], fresh: 'limited' };
        },
      },
      { now: () => T0 },
    );

    const prior = await queue.sourcesForTitle(title);
    const rebuilt = queue.sourcesForTitle(title, false, true);
    await expect(queue.sourcesForTitle(title, false, true)).resolves.toEqual({
      ...prior,
      fresh: 'limited',
    });
    releaseRebuild();
    await expect(rebuilt).resolves.toMatchObject({ sources: [second], fresh: 'rebuilt' });

    expect(await queue.sourcesForTitle(title)).toEqual({ sources: [second] });
    expect(asked).toEqual([false, true, true]);
  });

  it.each([
    ['older admitted rebuild completes first', false],
    ['newer admitted rebuild completes first', true],
  ])('keeps the newer of two admitted rebuilds canonical: %s', async (_order, newerFirst) => {
    const newest = source('Rebecka.S02E03.720p.WEB-DL.mkv', {
      resolution: '720p',
      cached: false,
      seeders: 20,
    });
    let asks = 0;
    let freshAsks = 0;
    let releaseOlder!: () => void;
    let releaseNewer!: () => void;
    const olderHeld = new Promise<void>((resolve) => (releaseOlder = resolve));
    const newerHeld = new Promise<void>((resolve) => (releaseNewer = resolve));
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, fresh) => {
          asks++;
          if (!fresh) return { sources: [first] };
          const request = freshAsks++;
          await (request === 0 ? olderHeld : newerHeld);
          return {
            sources: [request === 0 ? second : newest],
            fresh: 'rebuilt',
          };
        },
      },
      { now: () => T0 },
    );

    await queue.sourcesForTitle(title);
    const older = queue.sourcesForTitle(title, false, true);
    const newer = queue.sourcesForTitle(title, false, true);
    if (newerFirst) {
      releaseNewer();
      await expect(newer).resolves.toMatchObject({ sources: [newest], fresh: 'rebuilt' });
      releaseOlder();
      await expect(older).resolves.toMatchObject({ sources: [second], fresh: 'rebuilt' });
    } else {
      releaseOlder();
      await expect(older).resolves.toMatchObject({ sources: [second], fresh: 'rebuilt' });
      releaseNewer();
      await expect(newer).resolves.toMatchObject({ sources: [newest], fresh: 'rebuilt' });
    }

    expect(await queue.sourcesForTitle(title)).toEqual({ sources: [newest] });
    expect(asks).toBe(3);
  });

  it('keeps a published fresh result authoritative when a newer overlapping refresh is limited', async () => {
    const asked: boolean[] = [];
    let freshAsks = 0;
    let releaseFirstFresh!: () => void;
    let releasePlain!: () => void;
    const firstFreshHeld = new Promise<void>((resolve) => (releaseFirstFresh = resolve));
    const plainHeld = new Promise<void>((resolve) => (releasePlain = resolve));
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, fresh) => {
          asked.push(fresh === true);
          if (!fresh) {
            await plainHeld;
            return { sources: [first] };
          }
          if (freshAsks++ === 0) {
            await firstFreshHeld;
            return { sources: [second], fresh: 'rebuilt' };
          }
          return { sources: [first], fresh: 'limited' };
        },
      },
      { now: () => T0 },
    );

    const rebuilt = queue.sourcesForTitle(title, false, true);
    const viewer = queue.sourcesForTitle(title);
    releaseFirstFresh();
    await expect(rebuilt).resolves.toMatchObject({ sources: [second], fresh: 'rebuilt' });
    await expect(queue.sourcesForTitle(title, false, true)).resolves.toEqual({
      sources: [second],
      fresh: 'limited',
    });
    releasePlain();
    await expect(viewer).resolves.toEqual({ sources: [first] });

    expect(await queue.sourcesForTitle(title)).toEqual({ sources: [second] });
    expect(asked).toEqual([true, false, true]);
  });

  it('reports limited separately and retains the exact cached list and coverage without extending it', async () => {
    let asks = 0;
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, fresh) => {
          asks++;
          return fresh
            ? {
                sources: [second],
                answer: { kind: 'partial', missing: 2 },
                fresh: 'limited',
              }
            : { sources: [first], answer: { kind: 'live', missing: 0 } };
        },
      },
      { now: () => T0 },
    );
    const prior = await queue.sourcesForTitle(title);
    const limited = await queue.sourcesForTitle(title, false, true);
    expect(limited).toEqual({ ...prior, fresh: 'limited' });
    expect(await queue.sourcesForTitle(title)).toEqual(prior);
    expect(asks).toBe(2);
  });

  it('does not hand an action-only limited marker to a plain viewer arriving during the refresh', async () => {
    const asked: boolean[] = [];
    let releaseFresh!: () => void;
    const freshHeld = new Promise<void>((resolve) => (releaseFresh = resolve));
    const queue = new DownloadCoordinator(
      testLog().log,
      clock(),
      {
        ...effects(),
        resolve: async (_title, fresh) => {
          asked.push(fresh === true);
          if (fresh) {
            await freshHeld;
            return { sources: [second], fresh: 'limited' };
          }
          return { sources: [first], answer: { kind: 'live', missing: 0 } };
        },
      },
      { now: () => T0 },
    );
    const limited = queue.sourcesForTitle(title, false, true);
    const viewer = await queue.sourcesForTitle(title);
    expect(viewer).toEqual({ sources: [first], answer: { kind: 'live', missing: 0 } });
    expect(viewer).not.toHaveProperty('fresh');
    releaseFresh();
    await expect(limited).resolves.toMatchObject({ fresh: 'limited' });
    expect(await queue.sourcesForTitle(title)).toEqual(viewer);
    expect(asked).toEqual([true, false]);
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

  it('keeps a live download when its upstream cancellation is refused', async () => {
    const shared = testLog();
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      { ...effects(), cancel: async () => false },
      { now: () => T0 },
    );
    await queue.enqueue(title, first, 1);
    await Promise.resolve();
    const download = queue.get(NAME)!;

    await expect(queue.remove(download, true)).resolves.toBe(false);
    expect(queue.get(NAME)).toBeDefined();
    expect(shared.log.settings(NAME)?.values.removed).toBeUndefined();
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

  it('does not create an unhandled rejection while clearing an aborted pass', async () => {
    const shared = testLog([stalledRow()]);
    const aborted = new DOMException('stopped', 'AbortError');
    let attempts = 0;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async () => {
          attempts++;
          if (attempts === 1) throw aborted;
          return { state: 'preparing', progress: 0 };
        },
      },
      { now: () => T0 + MINUTE, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => {
      if (reason === aborted) unhandled.push(reason);
    };
    process.on('unhandledRejection', observe);
    try {
      await expect(driver.run({ now: T0 + MINUTE, observedFor: 0 })).rejects.toBe(aborted);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await expect(driver.run({ now: T0 + MINUTE, observedFor: 0 })).resolves.toBe(true);
    } finally {
      process.off('unhandledRejection', observe);
    }
    expect(attempts).toBe(2);
  });

  it('answers a refresh asked during a pass with a pass of its own, not the one in flight', async () => {
    const shared = testLog([stalledRow()]);
    const asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let polled!: () => void;
    const polling = new Promise<void>((resolve) => (polled = resolve));
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        prepare: async (url: string) => {
          asked.push(url);
          polled();
          await gate;
          return { state: 'preparing' as const, progress: 0 };
        },
      },
      { now: () => T0 + MINUTE, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);

    const scheduled = driver.run({ observedFor: 0 });
    await polling;
    const refreshed = driver.run({ force: true, observedFor: 0 });
    const again = driver.run({ force: true, observedFor: 0 });
    release();
    await scheduled;
    await Promise.all([refreshed, again]);
    // The refreshes polled again, in one pass after the one that was already polling when they were asked.
    expect(asked).toEqual([first.url, first.url]);
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

  it('retries a failed final Hearth clear on maintenance, then keeps acknowledged empty quiet', async () => {
    const shared = testLog();
    const handed: unknown[][] = [];
    const answers: Array<[] | null> = [[], null, null, []];
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => ({ sources: [] }),
        wanted: async (items) => {
          handed.push(items);
          return answers.length ? answers.shift()! : [];
        },
      },
      { now: () => T0, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    await queue.want(title);

    await driver.run({ now: T0 + MINUTE, observedFor: 0 });
    expect(handed.map((items) => items.length)).toEqual([1]);
    const download = queue.get(NAME)!;
    shared.land(removedRow(download.row, [T0 + 2 * MINUTE, 0, DEVICE]));

    await driver.run({ now: T0 + 2 * MINUTE, observedFor: 0 });
    expect(handed.map((items) => items.length)).toEqual([1, 0]);
    await driver.run({ now: T0 + 2 * MINUTE + 30_000, observedFor: 0 });
    expect(handed.map((items) => items.length)).toEqual([1, 0, 0]);
    await driver.run({ now: T0 + 3 * MINUTE, observedFor: 0 });
    expect(handed.map((items) => items.length)).toEqual([1, 0, 0, 0]);
    await driver.run({ now: T0 + 3 * MINUTE + 30_000, observedFor: 0 });
    expect(handed).toHaveLength(4);
  });

  it('sends one empty Hearth replacement after reopen, then leaves it quiet', async () => {
    const handed: unknown[][] = [];
    const queue = new DownloadCoordinator(testLog().log, clock(), {
      ...effects(),
      wanted: async (items) => {
        handed.push(items);
        return [];
      },
    });
    const driver = new DownloadCoordinatorDriver(queue);

    await driver.run({ now: T0 + 30_000, observedFor: 120_001 });
    expect(handed).toEqual([[]]);
    await driver.run({ now: T0 + MINUTE, observedFor: 120_001 });
    expect(handed).toEqual([[]]);
  });

  it('rebinds the same digest to a replacement Hearth and fences the old response', async () => {
    const handed: number[] = [];
    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sending = new Promise<void>((resolve) => (started = resolve));
    const queue = new DownloadCoordinator(testLog().log, clock(), {
      ...effects(),
      wanted: async (items) => {
        handed.push(items.length);
        if (!calls++) {
          started();
          await gate;
        }
        return [];
      },
    });
    const driver = new DownloadCoordinatorDriver(queue);
    const old = driver.run({ now: T0, observedFor: 120_001 }, {});
    await sending;
    const replacement = driver.run({ now: T0 + 30_000, observedFor: 120_001 }, {});
    release();
    await expect(old).resolves.toBe(false);
    await replacement;
    expect(handed).toEqual([0, 0]);
    await driver.run({ now: T0 + MINUTE, observedFor: 120_001 }, null);
    expect(handed).toHaveLength(2);
  });

  it('does not let a late clear from a replaced authority suppress newer wanted intent', async () => {
    const shared = testLog();
    const handed: unknown[][] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sending = new Promise<void>((resolve) => (started = resolve));
    let current = true;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => ({ sources: [] }),
        wanted: async (items) => {
          handed.push(items);
          if (!items.length) {
            started();
            await gate;
          }
          return [];
        },
      },
      { now: () => T0, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    await queue.want(title);
    await driver.run({ now: T0 + MINUTE, observedFor: 0 });
    shared.land(removedRow(queue.get(NAME)!.row, [T0 + 2 * MINUTE, 0, DEVICE]));

    const clearing = driver.run({
      now: T0 + 2 * MINUTE,
      observedFor: 0,
      current: () => current,
    });
    await sending;
    await queue.want({ ...title, mediaId: 1400, episode: 4 });
    current = false;
    release();
    await expect(clearing).resolves.toBe(false);

    await driver.run({ now: T0 + 2 * MINUTE, observedFor: 0 });
    expect(handed.map((items) => items.length)).toEqual([1, 0, 1]);
  });

  it('keeps a cancelled clear pending across lease replacement and sends it after reacquisition', async () => {
    const shared = testLog();
    const handed: unknown[][] = [];
    const cancelled = new DOMException('cancelled', 'AbortError');
    let cancelEmpty = true;
    const queue = new DownloadCoordinator(
      shared.log,
      clock(),
      {
        ...effects(),
        resolve: async () => ({ sources: [] }),
        wanted: async (items) => {
          handed.push(items);
          if (!items.length && cancelEmpty) throw cancelled;
          return [];
        },
      },
      { now: () => T0, monotonicNow: () => 0 },
    );
    const driver = new DownloadCoordinatorDriver(queue);
    await queue.want(title);
    await driver.run({ now: T0 + MINUTE, observedFor: 0 });
    shared.land(removedRow(queue.get(NAME)!.row, [T0 + 2 * MINUTE, 0, DEVICE]));

    await expect(driver.run({ now: T0 + 2 * MINUTE, observedFor: 0 })).resolves.toBe(false);

    const lease = shared.log.settings(LEASE_ROW)!;
    shared.land({
      ...lease,
      values: {
        ...lease.values,
        lease: { value: { strings: [TV, '2'] }, at: [T0 + 2 * MINUTE + 1, 0, TV] },
      },
    });
    cancelEmpty = false;
    await driver.run({ now: T0 + 2 * MINUTE + 30_000, observedFor: 0 });
    expect(handed).toHaveLength(2);

    shared.land({
      ...shared.log.settings(LEASE_ROW)!,
      values: {
        ...shared.log.settings(LEASE_ROW)!.values,
        lease: { value: { strings: ['', '2'] }, at: [T0 + 2 * MINUTE + 15_000, 0, TV] },
      },
    });
    await driver.run({ now: T0 + 3 * MINUTE, observedFor: 120_001 });
    expect(handed.map((items) => items.length)).toEqual([1, 0, 0]);
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
      /** Passes every `step` up to `at`: every 30 s, as the service scheduler runs them, unless told otherwise. */
      const run = async (at: number, step = 30_000) => {
        do {
          now = Math.min(at, now + step);
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
      await run(T0 + 21 * MINUTE);
      // The race's stages are hours apart, so the rest of the day is passes an hour apart, not 2,800 at 30 s.
      await run(T0 + 23 * 60 * MINUTE, 60 * MINUTE);
      const before = readDownload(shared.log.settings(EPISODE)!)!;
      expect(before.release.identity).not.toBe(avi.identity);
      expect(before.race.stage).toBe(2);
      await run(T0 + 24 * 60 * MINUTE + MINUTE, 60 * MINUTE);
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
