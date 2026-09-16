import { describe, expect, it } from 'vitest';
import { activeAt, canAutoSkip, fetchSkipSegments, type SkipSegment } from './skipdb';

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

    expect(found.map((one) => [one.kind, one.start, one.end])).toEqual([
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

    expect(found).toEqual([{ kind: 'outro', start: 8331.3, end: 8552.6, confidence: 0.75 }]);
    expect(asked).toEqual(['/skipdb/tt0111161?duration=8520', '/skipdb/tt0111161']);
  });

  /** A title SkipDB holds nothing for must not be asked twice every time it plays. */
  it('asks once when SkipDB names no segment at all', async () => {
    const { fetchImpl, asked } = answering(
      body({ intro: null, recap: null, outro: null, preview: null }),
    );
    expect(await fetchSkipSegments('tt0111161', { durationSeconds: 8520, fetchImpl })).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it('is empty rather than an error when den-edge cannot answer', async () => {
    const refused: typeof fetch = async () => new Response('{}', { status: 502 });
    expect(await fetchSkipSegments('tt0111161', { fetchImpl: refused })).toEqual([]);
    const threw: typeof fetch = async () => {
      throw new Error('offline');
    };
    expect(await fetchSkipSegments('tt0111161', { fetchImpl: threw })).toEqual([]);
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
    expect(activeAt([segment({ confidence: 0.75 })], 150)?.kind).toBe('outro');
  });

  it('finds the segment under the playhead, and none between them', () => {
    const list = [segment({ kind: 'intro', start: 60, end: 90 }), segment()];
    expect(activeAt(list, 75)?.kind).toBe('intro');
    expect(activeAt(list, 150)?.kind).toBe('outro');
    expect(activeAt(list, 95)).toBeNull();
    expect(activeAt(list, 200)).toBeNull();
  });
});
