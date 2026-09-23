import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aheadIn,
  browserName,
  MAX_ERRORS,
  MAX_STALLS,
  percentile,
  PlaybackRecorder,
  reportBody,
  ReportSchedule,
  reportUrlOf,
  sendReport,
  type ReportEvent,
} from './playbackStats';

const noLive = { bandwidthEstimateKbps: null, droppedFrames: null, totalFrames: null };
const noRequests = { loading: null, idleMs: null };
const ranges = (...spans: [number, number][]) =>
  ({
    length: spans.length,
    start: (i: number) => spans[i]![0],
    end: (i: number) => spans[i]![1],
  }) as TimeRanges;

describe('percentile', () => {
  it('ranks to the nearest value', () => {
    const values = [50, 10, 40, 20, 30, 60, 70, 80, 90, 100];
    expect(percentile(values, 10)).toBe(10);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile([7], 10)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('aheadIn', () => {
  it('measures the range the play head is in, and nothing in a hole', () => {
    const buffered = ranges([0, 10], [12, 30]);
    expect(aheadIn(buffered, 4)).toBe(6);
    expect(aheadIn(buffered, 11), 'in the hole between them').toBe(0);
    expect(aheadIn(buffered, 11.92), 'just short of a range counts as in it').toBe(18.1);
  });
});

describe('PlaybackRecorder', () => {
  it('sums fragments and gives their transfer rates in kbit/s', () => {
    const recorder = new PlaybackRecorder('hls.js', 'Chrome 141 / Windows');
    // 1 MB between first and last byte in 2 s: 4000 kbit/s; the request took 2.5 s.
    recorder.fragment(1_000_000, { start: 0, first: 500, end: 2_500 });
    // 1 MB in 1 s: 8000 kbit/s.
    recorder.fragment(1_000_000, { start: 3_000, first: 3_100, end: 4_100 });
    recorder.fragment(0, { start: 0, first: 0, end: 1 });
    const { fragments } = recorder.snapshot('end', 0, noLive);
    expect(fragments).toEqual({
      count: 2,
      bytes: 2_000_000,
      loadMs: 3_600,
      slowestMs: 2_500,
      kbpsP10: 4_000,
      kbpsMedian: 4_000,
      idleLowMs: 0,
    });
  });

  it('sums the playing time spent idling on a low buffer', () => {
    const recorder = new PlaybackRecorder('hls.js', 'x');
    recorder.idleLow(250.4);
    recorder.idleLow(-5);
    recorder.idleLow(1_000);
    expect(recorder.snapshot('end', 0, noLive).fragments.idleLowMs).toBe(1_250);
  });

  it('keeps the first stalls and counts the rest, one per stall however many signals say so', () => {
    const recorder = new PlaybackRecorder('hls.js', 'x');
    for (let i = 0; i < MAX_STALLS + 5; i++) {
      expect(
        recorder.stalled(i * 1_000, {
          at: i,
          kind: 'wait',
          videoAhead: 0,
          audioAhead: 9,
          ...noRequests,
        }),
      ).toBe(true);
      expect(
        recorder.stalled(i * 1_000 + 1, {
          at: i,
          kind: 'wait',
          videoAhead: 0,
          audioAhead: 9,
          ...noRequests,
        }),
      ).toBe(false);
      recorder.resumed(i * 1_000 + 400);
    }
    recorder.stalled(99_000, {
      at: 99,
      kind: 'frozen',
      videoAhead: 0,
      audioAhead: 4,
      ...noRequests,
    });
    const stats = recorder.snapshot('stall', 99_250, noLive);
    expect(stats.stalls).toHaveLength(MAX_STALLS);
    expect(stats.stalls[0]).toEqual({
      at: 0,
      ms: 400,
      kind: 'wait',
      videoAhead: 0,
      audioAhead: 9,
      ...noRequests,
    });
    expect(stats.stallCount).toBe(MAX_STALLS + 6);
    expect(stats.stalledMs, 'the open stall so far included').toBe((MAX_STALLS + 5) * 400 + 250);
  });

  it('keeps each error once with its count, up to the cap', () => {
    const recorder = new PlaybackRecorder('hls.js', 'x');
    recorder.error('bufferStalledError', false);
    recorder.error('bufferStalledError', false);
    recorder.error('bufferStalledError', true);
    for (let i = 0; i < MAX_ERRORS; i++) recorder.error(`other${i}`, false);
    const { errors } = recorder.snapshot('end', 0, noLive);
    expect(errors).toHaveLength(MAX_ERRORS);
    expect(errors[0]).toEqual({ details: 'bufferStalledError', fatal: false, count: 2 });
    expect(errors[1]).toEqual({ details: 'bufferStalledError', fatal: true, count: 1 });
  });
});

describe('reportBody', () => {
  const full = () => {
    const recorder = new PlaybackRecorder('hls.js', 'Chrome 141 / Windows');
    for (let i = 0; i < MAX_STALLS; i++) {
      recorder.stalled(i, { at: i, kind: 'wait', videoAhead: 0, audioAhead: 1, ...noRequests });
      recorder.resumed(i + 1);
    }
    for (let i = 0; i < MAX_ERRORS; i++) recorder.error(`error ${'x'.repeat(60)} ${i}`, false);
    return recorder.snapshot('stall', 0, noLive);
  };

  it('keeps den-remux’s code and message beside the stats', () => {
    const body = JSON.parse(reportBody(0, 'playback stats (stall)', full())) as Record<
      string,
      unknown
    >;
    expect(body.code).toBe(0);
    expect(body.message).toBe('playback stats (stall)');
    expect(body.stats).toMatchObject({ event: 'stall', engine: 'hls.js' });
  });

  it('stays under the byte cap by dropping the latest stalls and errors first', () => {
    const text = reportBody(0, 'm', full(), 1_500);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1_500);
    const { stats } = JSON.parse(text) as {
      stats: { stalls: { at: number }[]; errors: { details: string }[] };
    };
    expect(stats.stalls[0]?.at, 'the first stall is the last to go').toBe(0);
    expect(stats.errors.every((e, i) => e.details.endsWith(` ${i}`))).toBe(true);
    expect(stats.stalls.length).toBeLessThan(MAX_STALLS);
  });

  it('fits the default cap with every list full', () => {
    expect(new TextEncoder().encode(reportBody(0, 'm'.repeat(500), full())).length).toBeLessThan(
      8 * 1024,
    );
  });
});

describe('ReportSchedule', () => {
  afterEach(() => vi.useRealTimers());

  const scheduled = () => {
    vi.useFakeTimers();
    const sent: [ReportEvent, number][] = [];
    const schedule = new ReportSchedule(
      (event) => sent.push([event, Date.now()]),
      () => Date.now(),
      30_000,
    );
    return { sent, schedule, start: Date.now() };
  };

  it('sends at the first stall, once more at least 30 s on, and keeps the last for the end', () => {
    const { sent, schedule, start } = scheduled();
    schedule.stall();
    expect(sent).toEqual([['stall', start]]);
    vi.advanceTimersByTime(5_000);
    schedule.stall();
    schedule.stall();
    expect(sent, 'a stall inside the interval waits').toHaveLength(1);
    vi.advanceTimersByTime(25_000);
    expect(sent).toEqual([
      ['stall', start],
      ['stall', start + 30_000],
    ]);
    vi.advanceTimersByTime(60_000);
    schedule.stall();
    schedule.hidden();
    expect(sent, 'the third is the end’s').toHaveLength(2);
    schedule.end();
    schedule.end();
    expect(sent.map(([event]) => event)).toEqual(['stall', 'stall', 'end']);
  });

  it('sends nothing but the end for a session that never stalled', () => {
    const { sent, schedule } = scheduled();
    schedule.end();
    schedule.stall();
    expect(sent.map(([event]) => event)).toEqual(['end']);
  });

  it('reports a hidden page while a report is spare, and a waiting stall report never follows the end', () => {
    const { sent, schedule } = scheduled();
    schedule.stall();
    schedule.stall(); // waits for its interval
    schedule.end();
    vi.advanceTimersByTime(60_000);
    expect(sent.map(([event]) => event)).toEqual(['stall', 'end']);

    const second = scheduled();
    second.schedule.hidden();
    second.schedule.stall();
    vi.advanceTimersByTime(30_000);
    second.schedule.end();
    expect(second.sent.map(([event]) => event)).toEqual(['hidden', 'stall', 'end']);
  });

  it('counts a failure report sent to the session from elsewhere', () => {
    const { sent, schedule } = scheduled();
    schedule.stall();
    schedule.spent();
    vi.advanceTimersByTime(30_000);
    schedule.stall();
    schedule.end();
    expect(sent.map(([event]) => event)).toEqual(['stall', 'end']);

    const late = scheduled();
    late.schedule.stall();
    vi.advanceTimersByTime(30_000);
    late.schedule.stall();
    late.schedule.spent();
    late.schedule.end();
    expect(
      late.sent.map(([event]) => event),
      'three already went',
    ).toEqual(['stall', 'stall']);
  });
});

describe('browserName', () => {
  it('reads the client hints, without the placeholder brands', () => {
    expect(
      browserName({
        userAgent: 'whatever',
        userAgentData: {
          brands: [
            { brand: 'Not)A;Brand', version: '99' },
            { brand: 'Chromium', version: '141' },
            { brand: 'Google Chrome', version: '141' },
          ],
          platform: 'Windows',
        },
      }),
    ).toBe('Google Chrome 141 / Windows');
  });

  it('reads the browser and OS out of a user agent, and nothing else of it', () => {
    const cases: [string, string][] = [
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
        'Firefox 140 / Windows',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
        'Safari 26 / macOS',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
        'Safari 26 / iOS',
      ],
      [
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
        'Edge 141 / Linux',
      ],
      ['curl/8', 'unknown browser / unknown OS'],
    ];
    for (const [userAgent, name] of cases) expect(browserName({ userAgent }), userAgent).toBe(name);
  });
});

describe('sendReport', () => {
  it('posts beside the playlist, kept alive, and warns rather than retries when it fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls: [string, RequestInit | undefined][] = [];
    const url = reportUrlOf('https://media.example/remux/s/a/b/master.m3u8');
    expect(url).toBe('https://media.example/remux/s/a/b/report');
    sendReport(url, '{}', async (input, init) => {
      calls.push([String(input), init]);
      throw new TypeError('offline');
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ method: 'POST', body: '{}', keepalive: true });

    sendReport(url, '{}', async () => new Response(null, { status: 429 }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });
});
