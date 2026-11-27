import { describe, expect, it } from 'vitest';
import {
  activeAt,
  AUTO_SKIP_GRACE_MS,
  autoSkipCountdown,
  canAutoSkip,
  cancelsAutoSkip,
  fetchSkipSegments,
  nextAutoSkip,
  recheckDue,
  SKIP_LABEL,
  type PendingAutoSkip,
  type SkipSegment,
} from './skipdb';
import { sourcePhrases as spanish } from './messages/phrases/es';
import { sourcePhrases as swedish } from './messages/phrases/sv';

const segment = (over: Partial<SkipSegment> = {}): SkipSegment => ({
  kind: 'outro',
  start: 100,
  end: 200,
  confidence: 0.9,
  ...over,
});

/** SkipDB's own shape: milliseconds, and a `match` saying how well the times fit the encode we named. */
const body = (segments: Record<string, unknown>) => JSON.stringify({ segments });

const answering = (...bodies: string[]): { fetchImpl: typeof fetch; asked: string[] } => {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    const next = bodies[Math.min(asked.length - 1, bodies.length - 1)] ?? '{}';
    return new Response(next, { status: 200 });
  };
  return { fetchImpl, asked };
};

describe('fetchSkipSegments', () => {
  it('reads milliseconds as seconds and names the episode and the runtime', async () => {
    const { fetchImpl, asked } = answering(
      body({
        intro: { start_ms: 61_000, end_ms: 91_000, match: 'exact', confidence: 0.93 },
        outro: { start_ms: 2_760_000, end_ms: 2_820_000, match: 'shifted', confidence: 0.82 },
      }),
    );
    const found = await fetchSkipSegments('tt0903747', {
      season: 1,
      episode: 1,
      durationSeconds: 2820,
      fetchImpl,
    });

    expect(found.segments.map((one) => [one.kind, one.start, one.end])).toEqual([
      ['intro', 61, 91],
      ['outro', 2760, 2820],
    ]);
    expect(asked[0]).toBe('/skipdb/tt0903747/1/1?duration=2820');
  });

  /**
   * The release is usually not the encode SkipDB's community timed, and it answers `out-of-range` then — times
   * it deliberately leaves unadjusted. Dropping them used to mean no button and nothing to say why.
   */
  it('asks again without the runtime when everything came back out-of-range', async () => {
    const { fetchImpl, asked } = answering(
      body({
        outro: { start_ms: 8_331_300, end_ms: 8_552_600, match: 'out-of-range', confidence: 0.6 },
      }),
      body({
        outro: { start_ms: 8_331_300, end_ms: 8_552_600, match: 'agnostic', confidence: 0.75 },
      }),
    );
    const found = await fetchSkipSegments('tt0111161', { durationSeconds: 8520, fetchImpl });

    expect(found.segments).toEqual([
      { kind: 'outro', start: 8331.3, end: 8552.6, confidence: 0.75 },
    ]);
    expect(asked).toEqual(['/skipdb/tt0111161?duration=8520', '/skipdb/tt0111161']);
  });

  /** A title SkipDB holds nothing for must not be asked twice every time it plays. */
  it('asks once when SkipDB names no segment at all', async () => {
    const { fetchImpl, asked } = answering(
      body({ intro: null, recap: null, outro: null, preview: null }),
    );
    expect(await fetchSkipSegments('tt0111161', { durationSeconds: 8520, fetchImpl })).toEqual({
      segments: [],
      settled: false,
    });
    expect(asked).toHaveLength(1);
  });

  it('is empty rather than an error when den-edge cannot answer, and may be asked again', async () => {
    const refused: typeof fetch = async () => new Response('{}', { status: 502 });
    const empty = { segments: [], settled: false };
    expect(await fetchSkipSegments('tt0111161', { fetchImpl: refused })).toEqual(empty);
    const threw: typeof fetch = async () => {
      throw new Error('offline');
    };
    expect(await fetchSkipSegments('tt0111161', { fetchImpl: threw })).toEqual(empty);
  });

  /** den-edge marks a miss no scan will change; a pending scan's miss is unmarked (`skipdb.rs::detected`). */
  it('reads whether a miss is settled', async () => {
    const miss =
      (said?: string): typeof fetch =>
      async () =>
        new Response('{"error":"not_found"}', {
          status: 404,
          headers: said ? { 'x-den-skipdb': said } : {},
        });
    const at = (said?: string) =>
      fetchSkipSegments('tt0903747', { season: 1, episode: 1, fetchImpl: miss(said) });
    expect((await at('none')).settled).toBe(true);
    expect((await at('unavailable')).settled).toBe(true);
    expect((await at()).settled).toBe(false);
    expect((await at('hit')).settled).toBe(false);
  });
});

/**
 * The Apple TV's `refreshSkipSegmentsAfterScan` (`PlayerView+SkipSegments.swift`): a miss asked again ~45 s and ~120 s
 * after its first answer, then once in the last 12 minutes — never more.
 */
describe('re-asking a miss', () => {
  const length = 2700;

  it('asks at 45 s and 120 s after the first answer, then near the end', () => {
    expect(recheckDue(0, 44.9, 50, length)).toBe(false);
    expect(recheckDue(0, 45, 50, length)).toBe(true);
    expect(recheckDue(1, 119, 125, length)).toBe(false);
    expect(recheckDue(1, 120, 125, length)).toBe(true);
    // The third waits for the last 12 minutes, however long ago the first answer was.
    expect(recheckDue(2, 900, 1979, length)).toBe(false);
    expect(recheckDue(2, 900, 1980, length)).toBe(true);
  });

  it('keeps the order: a play resumed near the end still waits out the first two', () => {
    expect(recheckDue(0, 10, 2650, length)).toBe(false);
    expect(recheckDue(2, 10, 2650, length)).toBe(true);
  });

  it('stops after three, and never asks near an end it does not know', () => {
    expect(recheckDue(3, 5_000, 2699, length)).toBe(false);
    expect(recheckDue(2, 900, 10, 0)).toBe(false);
  });
});

describe('what may be skipped unasked', () => {
  /**
   * The line has to sit where the tvOS app's does, or the same release behaves differently on the TV and in
   * the browser: exact (0.9) and shifted (0.82) were aligned to this encode, agnostic (0.75) was not.
   */
  it('acts only on times aligned to this encode, and offers the rest', () => {
    expect(canAutoSkip(segment({ confidence: 0.9 }))).toBe(true);
    expect(canAutoSkip(segment({ confidence: 0.82 }))).toBe(true);
    expect(canAutoSkip(segment({ confidence: 0.75 }))).toBe(false);
    // Still under the playhead, whatever its confidence — a button is offered where a jump is not.
    expect(activeAt([segment({ confidence: 0.75 })], 150, 200)?.kind).toBe('outro');
  });

  it('finds the segment under the playhead, and none between them', () => {
    const list = [segment({ kind: 'intro', start: 60, end: 90 }), segment()];
    expect(activeAt(list, 75, 200)?.kind).toBe('intro');
    expect(activeAt(list, 150, 200)?.kind).toBe('outro');
    expect(activeAt(list, 95, 200)).toBeNull();
    expect(activeAt(list, 200, 200)).toBeNull();
  });

  it('ignores an outro in the front half of the title, or before the duration is known', () => {
    const early = segment({ start: 100, end: 200, confidence: 0.9 });
    expect(activeAt([early], 150, 1_320)).toBeNull();
    expect(activeAt([early], 150, 0)).toBeNull();
    const late = segment({ start: 1_250, end: 1_320 });
    expect(activeAt([late], 1_260, 0)).toBeNull();
    expect(activeAt([late], 1_260, 1_320)).toBe(late);
    const intro = segment({ kind: 'intro', start: 10, end: 40 });
    expect(activeAt([intro], 20, 0)).toBe(intro);
  });
});

/**
 * The Apple TV's `maybeAutoSkip` (`PlayerModel+Watchdog.swift`), tick by tick: an 8 s visible countdown from the first
 * tick inside an eligible segment, the skip on the first tick at or after its deadline, and nothing for low confidence,
 * a disabled setting or a kind this playback already settled.
 */
describe('auto-skip grace', () => {
  const intro = segment({ kind: 'intro', start: 0, end: 40 });

  it('counts down for 8 seconds, then skips on the first tick at or past the deadline', () => {
    const started = nextAutoSkip(true, intro, false, null, 1_000);
    expect(started).toEqual({ segment: intro, deadline: 1_000 + AUTO_SKIP_GRACE_MS });
    const pending = started as PendingAutoSkip;
    expect(autoSkipCountdown(pending, 1_000)).toBe(8);
    // The same object while it waits, so the player keeps one pending skip rather than allocating per tick.
    expect(nextAutoSkip(true, intro, false, pending, 1_250)).toBe(pending);
    expect(autoSkipCountdown(pending, 1_250)).toBe(8);
    expect(autoSkipCountdown(pending, 2_000)).toBe(7);
    expect(autoSkipCountdown(pending, 8_999)).toBe(1);
    expect(nextAutoSkip(true, intro, false, pending, 8_999.9)).toBe(pending);
    expect(nextAutoSkip(true, intro, false, pending, 9_000)).toBe('skip');
    // A stalled player's next tick, long after the deadline, still skips once rather than restarting.
    expect(nextAutoSkip(true, intro, false, pending, 60_000)).toBe('skip');
  });

  it('matches the same segment by value, so a refetched list keeps the countdown', () => {
    const pending = nextAutoSkip(true, intro, false, null, 0) as PendingAutoSkip;
    expect(nextAutoSkip(true, { ...intro }, false, pending, 4_000)).toBe(pending);
    const moved = nextAutoSkip(true, { ...intro, end: 45 }, false, pending, 4_000);
    expect(moved).toEqual({ segment: { ...intro, end: 45 }, deadline: 4_000 + AUTO_SKIP_GRACE_MS });
  });

  it('never acts on low confidence, a disabled setting or a settled kind', () => {
    expect(nextAutoSkip(true, segment({ confidence: 0.75 }), false, null, 0)).toBeNull();
    expect(nextAutoSkip(false, intro, false, null, 0)).toBeNull();
    expect(nextAutoSkip(true, intro, true, null, 0)).toBeNull();
    expect(nextAutoSkip(true, null, false, null, 0)).toBeNull();
    const pending = nextAutoSkip(true, intro, false, null, 0) as PendingAutoSkip;
    // Turning the setting off, or the kind being settled, retires a countdown already running — even past its deadline.
    expect(nextAutoSkip(false, intro, false, pending, 9_000)).toBeNull();
    expect(nextAutoSkip(true, intro, true, pending, 9_000)).toBeNull();
  });

  it('drops the countdown on leaving the segment and starts a fresh one on coming back', () => {
    const pending = nextAutoSkip(true, intro, false, null, 0) as PendingAutoSkip;
    expect(nextAutoSkip(true, null, false, pending, 5_000)).toBeNull();
    expect(nextAutoSkip(true, intro, false, null, 6_000)).toEqual({
      segment: intro,
      deadline: 6_000 + AUTO_SKIP_GRACE_MS,
    });
  });

  it('is cancelled by play/pause and by a seek inside the segment, not by one that leaves it', () => {
    const pending = nextAutoSkip(true, intro, false, null, 0) as PendingAutoSkip;
    expect(cancelsAutoSkip(pending)).toBe(true);
    expect(cancelsAutoSkip(pending, 10)).toBe(true);
    expect(cancelsAutoSkip(pending, 0)).toBe(true);
    expect(cancelsAutoSkip(pending, 40)).toBe(false);
    expect(cancelsAutoSkip(pending, 120)).toBe(false);
    expect(cancelsAutoSkip(null)).toBe(false);
  });

  it('has Spanish and Swedish for every Skip label', () => {
    for (const label of Object.values(SKIP_LABEL)) {
      expect(spanish[label], label).toBeTruthy();
      expect(swedish[label], label).toBeTruthy();
    }
  });
});
