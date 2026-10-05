import { describe, expect, it } from 'vitest';
import { DownloadQueue, POLL_MAX_MS, POLL_MS, pollDelay } from './downloadQueue.svelte';
import { downloadName, readDownload, readDownloads } from './downloadRows';
import { source, testClock, testLog } from './downloadTestLog';
import type { Preparation } from './titleSources';

describe('pollDelay', () => {
  it('asks every five seconds while a download moves', () => {
    expect(pollDelay(0)).toBe(POLL_MS);
  });

  it('backs off while nothing changes, to a minute at most', () => {
    expect(pollDelay(1)).toBe(10_000);
    expect(pollDelay(2)).toBe(20_000);
    expect(pollDelay(3)).toBe(40_000);
    expect(pollDelay(4)).toBe(POLL_MAX_MS);
    expect(pollDelay(40)).toBe(POLL_MAX_MS);
  });
});

const TV = 'aaaaaaaaaaaaaaaa';
const BROWSER = 'bbbbbbbbbbbbbbbb';

const episode = {
  mediaType: 'tv' as const,
  mediaId: 1399,
  imdbId: 'tt1',
  season: 2,
  episode: 3,
  title: 'Rebecka Martinsson',
  posterPath: '/poster.jpg',
};

function queue(answer: Preparation = { state: 'preparing', progress: 0 }) {
  const asked: string[] = [];
  const made = new DownloadQueue(async (url, add, prefetch) => {
    asked.push(`${add ? (prefetch ? 'prefetch' : 'add') : 'probe'} ${url}`);
    return answer;
  });
  return { made, asked };
}

describe('the queue is the library’s rows', () => {
  it('coalesces concurrent alternate adds and probes by row', async () => {
    let releaseAdd!: (answer: Preparation) => void;
    let releaseProbe!: (answer: Preparation) => void;
    const addAnswer = new Promise<Preparation>((resolve) => (releaseAdd = resolve));
    const probeAnswer = new Promise<Preparation>((resolve) => (releaseProbe = resolve));
    const asked: string[] = [];
    const made = new DownloadQueue(async (url, add) => {
      asked.push(`${add ? 'add' : 'probe'} ${url}`);
      return add ? addAnswer : probeAnswer;
    });

    const adding = [
      made.addHedge('download:one', '/scout/p/alternate'),
      made.addHedge('download:one', '/scout/p/alternate'),
    ];
    expect(asked).toEqual(['add /scout/p/alternate']);
    releaseAdd({ state: 'preparing', progress: 0.1 });
    await expect(Promise.all(adding)).resolves.toHaveLength(2);

    const download = {
      name: 'download:one',
      release: {
        identity: 'primary',
        label: 'Primary',
        url: '/scout/p/primary',
        hedge: {
          identity: 'alternate',
          url: '/scout/p/alternate',
          queuedAt: 1,
          progressAt: 1,
        },
      },
    } as Parameters<DownloadQueue['pollHedge']>[0];
    const probing = [made.pollHedge(download), made.pollHedge(download)];
    await Promise.resolve();
    expect(asked).toEqual(['add /scout/p/alternate', 'probe /scout/p/alternate']);
    releaseProbe({ state: 'not-queued' });
    await expect(Promise.all(probing)).resolves.toHaveLength(2);
  });

  it('does not publish an alternate add that finishes after switching libraries', async () => {
    let release!: (answer: Preparation) => void;
    const answer = new Promise<Preparation>((resolve) => (release = resolve));
    const made = new DownloadQueue(async () => answer);
    const first = testLog();
    const second = testLog();
    made.attach(first.log, testClock(BROWSER));
    const adding = made.addHedge('download:one', '/scout/p/alternate');
    made.attach(second.log, testClock(BROWSER));
    release({ state: 'preparing', progress: 0.1 });
    await adding;
    expect(made.hedgeAnswers.has('download:one')).toBe(false);
    expect(made.hedgeUrls.has('download:one')).toBe(false);
  });

  it('does not repopulate a cleared alternate from a late add completion', async () => {
    let release!: (answer: Preparation) => void;
    const answer = new Promise<Preparation>((resolve) => (release = resolve));
    const made = new DownloadQueue(async () => answer);
    const adding = made.addHedge('download:one', '/scout/p/old-alternate');
    made.clearHedge('download:one');
    release({ state: 'preparing', progress: 0.1 });
    await adding;
    expect(made.hedgeAnswers.has('download:one')).toBe(false);
    expect(made.hedgeUrls.has('download:one')).toBe(false);
  });

  it('does not coalesce a replacement alternate with the prior identity’s pending add', async () => {
    let releaseOld!: (answer: Preparation) => void;
    let releaseNew!: (answer: Preparation) => void;
    const oldAnswer = new Promise<Preparation>((resolve) => (releaseOld = resolve));
    const newAnswer = new Promise<Preparation>((resolve) => (releaseNew = resolve));
    const asked: string[] = [];
    const made = new DownloadQueue(async (url, add) => {
      asked.push(`${add ? 'add' : 'probe'} ${url}`);
      return url.endsWith('/old') ? oldAnswer : newAnswer;
    });
    const old = made.addHedge('download:one', '/scout/p/old', 'old');
    const replacement = {
      name: 'download:one',
      release: {
        identity: 'primary',
        label: 'Primary',
        url: '/scout/p/primary',
        hedge: { identity: 'new', url: '/scout/p/new', queuedAt: 2, progressAt: 2 },
      },
    } as Parameters<DownloadQueue['pollHedge']>[0];
    const current = made.pollHedge(replacement);
    await Promise.resolve();
    expect(asked).toEqual(['add /scout/p/old', 'probe /scout/p/new']);

    releaseOld({ state: 'preparing', progress: 0.1 });
    await old;
    expect(made.hedgeAnswers.has('download:one')).toBe(false);
    releaseNew({ state: 'not-queued' });
    await current;
    expect(made.hedgeAnswers.get('download:one')).toEqual({ state: 'not-queued' });
  });

  it('does not publish a primary probe that finishes after switching libraries', async () => {
    let release!: (answer: Preparation) => void;
    const answer = new Promise<Preparation>((resolve) => (release = resolve));
    const made = new DownloadQueue(async () => answer);
    const first = testLog();
    const second = testLog();
    made.attach(first.log, testClock(BROWSER));
    const download = {
      name: 'download:one',
      release: { identity: 'primary', label: 'Primary', url: '/scout/p/primary' },
    } as Parameters<DownloadQueue['poll']>[0];
    const polling = made.poll(download);
    made.attach(second.log, testClock(BROWSER));
    release({ state: 'ready' });
    await polling;
    expect(made.answers.has('download:one')).toBe(false);
  });

  it('does not restore or probe a cleared alternate after ticket resolution finishes late', async () => {
    let release!: (sources: Awaited<ReturnType<NonNullable<DownloadQueue['resolve']>>>) => void;
    const resolved = new Promise<Awaited<ReturnType<NonNullable<DownloadQueue['resolve']>>>>(
      (resolve) => (release = resolve),
    );
    const asked: string[] = [];
    const made = new DownloadQueue(async (url) => {
      asked.push(url);
      return { state: 'not-queued' };
    });
    const shared = testLog();
    made.attach(
      shared.log,
      testClock(BROWSER),
      () => null,
      async () => resolved,
    );
    const download = {
      name: 'download:one',
      title: episode,
      release: {
        identity: 'primary',
        label: 'Primary',
        url: '/scout/p/primary',
        hedge: {
          identity: 'alternate',
          url: 'http://another-device.invalid/ticket',
          queuedAt: 1,
          progressAt: 1,
        },
      },
    } as Parameters<DownloadQueue['pollHedge']>[0];
    const polling = made.pollHedge(download);
    made.clearHedge(download.name);
    release({ sources: [source('alternate', {}, 'fresh')] });
    await expect(polling).resolves.toBeUndefined();
    expect(asked).toEqual([]);
    expect(made.hedgeUrls.has(download.name)).toBe(false);
  });

  it('does not carry a no-alternate result into another library', () => {
    const made = new DownloadQueue();
    const first = testLog();
    const second = testLog();
    const download = {
      name: 'download:one',
      content: 'tv:1399:2:3',
      queuedAt: 1,
      tried: [],
      release: { identity: 'primary', label: 'Primary', url: '/scout/p/primary' },
    } as Parameters<DownloadQueue['hedgeResolveDue']>[0];
    made.attach(first.log, testClock(BROWSER));
    made.rememberNoHedge(download, 10_000);
    expect(made.hedgeResolveDue(download, 1)).toBe(false);
    made.attach(second.log, testClock(BROWSER));
    expect(made.hedgeResolveDue(download, 1)).toBe(true);
  });

  it('a download started here is a row every device reads back, named for the device that queued it', async () => {
    const shared = testLog();
    const { made: here, asked } = queue();
    here.attach(shared.log, testClock(BROWSER));
    const release = source('Rebecka.S02E03.2160p.WEB-DL.mkv', {
      resolution: '2160p',
      cached: false,
      seeders: 20,
      sizeBytes: 4e9,
    });
    await here.start({ title: episode, source: release, sources: [release] });
    expect(asked).toEqual(['prefetch /scout/p/Rebecka.S02E03.2160p.WEB-DL.mkv']);

    // The TV reads the same row: what to show, which release, and who queued it.
    const { made: tv } = queue();
    tv.attach(shared.log, testClock(TV));
    const [read] = tv.list();
    expect(read).toMatchObject({
      name: downloadName('tv:1399:2:3'),
      title: { mediaType: 'tv', mediaId: 1399, season: 2, episode: 3, title: 'Rebecka Martinsson' },
      release: { identity: 'rebecka.s02e03.2160p.web-dl.mkv', sizeBytes: 4e9, cached: false },
      queuedBy: BROWSER,
      candidates: 1,
    });
    expect(tv.status(read!).state).toBe('starting');
  });

  it('another release for the same episode starts over: nothing of the first is carried', async () => {
    const shared = testLog();
    const { made } = queue();
    made.attach(shared.log, testClock(BROWSER));
    await made.start({ title: episode, source: source('first.mkv') });
    const row = shared.log.settings(downloadName('tv:1399:2:3'))!;
    // As the lease holder would write after a stall.
    await shared.log.write({
      ...row,
      values: {
        ...row.values,
        tried: { value: { strings: ['old.mkv'] }, at: [Date.now() + 5, 0, TV] },
      },
    });
    await made.start({ title: episode, source: source('second.mkv') });
    const read = readDownload(shared.log.settings(downloadName('tv:1399:2:3'))!)!;
    expect(read.release.identity).toBe('second.mkv');
    expect(read.tried).toEqual([]);
  });

  it('a removal is a tombstone: the row is gone from the queue on every device', async () => {
    const shared = testLog();
    const { made, asked } = queue();
    made.attach(shared.log, testClock(BROWSER));
    await made.start({ title: episode, source: source('first.mkv') });
    await made.remove(made.list()[0]!, true);
    expect(readDownloads(shared.log.rows())).toEqual([]);
    expect(shared.log.settings(downloadName('tv:1399:2:3'))!.values.removed).toBeDefined();
    expect(asked.at(-1)).toBe('prefetch /scout/p/first.mkv');
  });

  it('cancel spares a release a sibling episode is still fetching', async () => {
    const shared = testLog();
    const cancelled: string[] = [];
    const made = new DownloadQueue(
      async () => ({ state: 'preparing', progress: 0.2 }),
      async (url) => {
        cancelled.push(url);
        return true;
      },
    );
    made.attach(shared.log, testClock(BROWSER));
    const pack = (ticket: string) => source('Show.S02.1080p.mkv', {}, ticket);
    await made.start({ title: episode, source: pack('three') });
    await made.start({ title: { ...episode, episode: 4 }, source: pack('four') });
    const three = made.of('tv', 1399, 2, 3)!;
    await made.remove(three, true);
    expect(cancelled).toEqual([]);
    await made.remove(made.of('tv', 1399, 2, 4)!, true);
    expect(cancelled).toEqual(['/scout/p/four']);
  });

  it('a cancel check den-core refuses cancels nothing and throws nothing', async () => {
    const shared = testLog();
    const cancelled: string[] = [];
    const made = new DownloadQueue(
      async () => ({ state: 'preparing', progress: 0.2 }),
      async (url) => {
        cancelled.push(url);
        return true;
      },
    );
    made.attach(shared.log, testClock(BROWSER));
    await made.start({ title: episode, source: source('Show.S02E03.1080p.mkv', {}, 'three') });
    const three = made.of('tv', 1399, 2, 3)!;
    // A row den-core can't read as a download: `download_cancel_safe` answers an error.
    await expect(
      made.cancelIfSafe({ ...three, row: { ...three.row, name: 'not-a-download' } }),
    ).resolves.toBeUndefined();
    expect(cancelled).toEqual([]);
  });

  it('a viewer can try a previous release beside the current one without cancelling either', async () => {
    const shared = testLog();
    const asked: string[] = [];
    const cancelled: string[] = [];
    const first = source('first.mkv');
    const second = source('second.mkv');
    const made = new DownloadQueue(
      async (url, add, prefetch) => {
        asked.push(`${add ? (prefetch ? 'prefetch' : 'add') : 'probe'} ${url}`);
        return { state: 'preparing', progress: url === first.url ? 0.97 : 0.2 };
      },
      async (url) => (cancelled.push(url), true),
    );
    made.attach(shared.log, testClock(BROWSER), undefined, async () => ({
      sources: [first, second],
    }));
    await made.start({ title: episode, source: second, sources: [first, second] });
    const current = made.list()[0]!;

    await expect(made.alternatives(current)).resolves.toEqual([first, second]);
    await made.tryAnother(current, first);

    const racing = made.list()[0]!;
    expect(racing.release.identity).toBe(second.identity);
    expect(racing.release.hedge?.identity).toBe(first.identity);
    expect(cancelled).toEqual([]);
    expect(asked).toEqual([`prefetch ${second.url}`, `prefetch ${first.url}`]);
  });

  it('coalesces a manual alternate with a concurrent status poll by release identity', async () => {
    const shared = testLog();
    const first = source('first.mkv');
    const second = source('second.mkv');
    let release!: (answer: Preparation) => void;
    const pending = new Promise<Preparation>((resolve) => (release = resolve));
    const asked: string[] = [];
    const made = new DownloadQueue(async (url, add) => {
      asked.push(`${add ? 'add' : 'probe'} ${url}`);
      return url === first.url ? pending : { state: 'preparing', progress: 0.2 };
    });
    made.attach(shared.log, testClock(BROWSER));
    await made.start({ title: episode, source: second, sources: [first, second] });

    const choosing = made.tryAnother(made.list()[0]!, first);
    await Promise.resolve();
    await Promise.resolve();
    const polling = made.pollHedge(made.list()[0]!);
    expect(asked).toEqual([`add ${second.url}`, `add ${first.url}`]);

    release({ state: 'preparing', progress: 0.4 });
    await expect(Promise.all([choosing, polling])).resolves.toHaveLength(2);
    expect(asked).toEqual([`add ${second.url}`, `add ${first.url}`]);
    expect(made.hedgeAnswers.get(made.list()[0]!.name)).toEqual({
      state: 'preparing',
      progress: 0.4,
    });
  });

  it('does not add a manual alternate after its library changes while the choice is saved', async () => {
    const first = testLog();
    const second = testLog();
    const primary = source('primary.mkv');
    const alternate = source('alternate.mkv');
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve));
    let delayWrite = false;
    const delayed = {
      ...first.log,
      async write(row: Parameters<typeof first.log.write>[0]) {
        if (delayWrite) await writeGate;
        return first.log.write(row);
      },
    } as typeof first.log;
    const asked: string[] = [];
    const made = new DownloadQueue(async (url) => {
      asked.push(url);
      return { state: 'preparing', progress: 0.1 };
    });
    made.attach(delayed, testClock(BROWSER));
    await made.start({ title: episode, source: primary });
    delayWrite = true;

    const choosing = made.tryAnother(made.list()[0]!, alternate);
    await Promise.resolve();
    made.attach(second.log, testClock(BROWSER));
    releaseWrite();

    await expect(choosing).resolves.toEqual({ state: 'unknown' });
    expect(asked).toEqual([primary.url]);
    expect(made.hedgeAnswers.size).toBe(0);
    expect(made.hedgeUrls.size).toBe(0);
  });

  it('discards release choices resolved after switching libraries', async () => {
    let release!: (value: { sources: ReturnType<typeof source>[] }) => void;
    const pending = new Promise<{ sources: ReturnType<typeof source>[] }>(
      (resolve) => (release = resolve),
    );
    const made = new DownloadQueue();
    const first = testLog();
    made.attach(first.log, testClock(BROWSER), undefined, async () => pending);
    const resolving = made.alternatives({ title: episode } as Parameters<
      DownloadQueue['alternatives']
    >[0]);

    made.attach(testLog().log, testClock(BROWSER));
    release({ sources: [source('old-library.mkv')] });

    await expect(resolving).resolves.toBeNull();
  });

  it('a ticket this browser can’t reach is renewed by identity, never asked as it is', async () => {
    const shared = testLog();
    const { made: tv } = queue();
    tv.attach(shared.log, testClock(TV));
    await tv.start({ title: episode, source: source('ep.mkv') });
    // Written as the TV writes it: its own LAN address, which a browser away from home can't ask.
    const row = shared.log.settings(downloadName('tv:1399:2:3'))!;
    const release = JSON.parse((row.values.release!.value as { string: string }).string);
    await shared.log.write({
      ...row,
      values: {
        ...row.values,
        release: {
          value: { string: JSON.stringify({ ...release, url: 'http://192.0.2.1:8080/p/old' }) },
          at: [Date.now() + 10, 0, TV],
        },
      },
    });
    const { made: browser, asked } = queue();
    browser.attach(
      shared.log,
      testClock(BROWSER),
      () => null,
      async () => ({
        sources: [source('ep.mkv', {}, 'fresh')],
      }),
    );
    const download = browser.list()[0]!;
    expect((await browser.poll(download)).state).toBe('expired');
    expect(asked).toEqual([]);
    expect(await browser.renew(download)).toBe('/scout/p/fresh');
    await browser.poll(download);
    expect(asked).toEqual(['probe /scout/p/fresh']);
  });
});

describe('the first pick is the TV’s (rank_releases)', () => {
  it('takes a cached release over a higher-ranked uncached one', () => {
    const { made } = queue();
    const picked = made.pick([
      source('4k.mkv', { resolution: '2160p', cached: false, seeders: 20 }),
      source('720p.mkv', { resolution: '720p', cached: true, seeders: 20 }),
    ]);
    expect(picked?.filename).toBe('720p.mkv');
  });

  it('sinks a proven dub of a title in another language', () => {
    const { made } = queue();
    const picked = made.pick(
      [
        source('ita.mkv', {
          resolution: '2160p',
          cached: false,
          probed: true,
          audioLanguages: ['ita'],
        }),
        source('swe.mkv', {
          resolution: '1080p',
          cached: false,
          probed: true,
          audioLanguages: ['swe'],
        }),
      ],
      'sv',
    );
    expect(picked?.filename).toBe('swe.mkv');
  });
});
