/**
 * What scout says about its own list (its `den` object): whether an empty list means nothing exists (`empty`) or
 * that it could not ask every source (`unknown`), whether a list may be short (`partial`), and whether it is a
 * held list served because no source answered (`outage`, with the time it was built). Absent from an older scout.
 *
 * Its own module, apart from `titleSources`, so the poster fade (`availability.svelte.ts`) reads it without the
 * source list's playback dependencies.
 */
export interface SourceAnswer {
  kind: 'live' | 'partial' | 'empty' | 'unknown' | 'stale';
  /** Sources that could have been asked and did not answer. */
  missing: number;
  /**
   * Sources still answering when a list asked for early (`fetchSourceList`'s `early`) went out without them: no
   * failure to tell the viewer of, but the list is not complete (scout calls it `partial`). Absent when none.
   */
  late?: number;
  /** A held list served in an outage, and when it was built (ms). */
  outage?: { builtAt: number };
}

const answerKinds = new Set(['live', 'partial', 'empty', 'unknown', 'stale']);
// A source that answered, or that can never be asked, is not one the list is waiting on.
const notMissing = new Set(['answered', 'skipped_misconfigured', 'quarantined']);
/** A source the list went out without because it asked for an early answer; it is still answering. */
const LATE = 'late';

export function parseAnswer(body: unknown): SourceAnswer | undefined {
  const den = (body as { den?: unknown } | null)?.den as
    | {
        answerKind?: unknown;
        degraded?: unknown;
        generatedAt?: unknown;
        coverage?: { sources?: unknown };
      }
    | undefined;
  if (!den || typeof den !== 'object' || !answerKinds.has(den.answerKind as string))
    return undefined;
  const sources: unknown[] = Array.isArray(den.coverage?.sources) ? den.coverage.sources : [];
  const builtAt = typeof den.generatedAt === 'string' ? Date.parse(den.generatedAt) : NaN;
  const outcomes = sources.map((s) => (s as { outcome?: unknown } | null)?.outcome as string);
  const late = outcomes.filter((outcome) => outcome === LATE).length;
  return {
    kind: den.answerKind as SourceAnswer['kind'],
    missing: outcomes.filter((outcome) => outcome !== LATE && !notMissing.has(outcome)).length,
    ...(late ? { late } : {}),
    outage: den.degraded === 'stale_list' && Number.isFinite(builtAt) ? { builtAt } : undefined,
  };
}
