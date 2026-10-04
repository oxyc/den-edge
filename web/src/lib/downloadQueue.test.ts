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
