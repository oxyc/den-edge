// SkipDB's intro/recap/outro segments, as den-edge keeps them (`/skipdb/<tt…>[/<season>/<episode>]`).
//
// Asked of THIS origin, never of api.skipdb.tv: the policy served with the app names no third-party origin in
// `connect-src`, and widening it for one feature is a poor trade — while den-edge keeping the answer means one
// household's first play warms it for every later viewer and every other browser.
//
// Plain `fetch`, not `relayFetch`: SkipDB's read API takes no key and den-edge's route asks for no membership,
// so there is no household credential to attach. `/skipdb/` is deliberately absent from that module's relayed
// allow-list for the same reason — the list is a security boundary, and a path belongs on it only when a
// credential must travel with it.

export type SkipKind = 'intro' | 'recap' | 'outro' | 'preview';

export interface SkipSegment {
  kind: SkipKind;
  /** Seconds, so they line up with the video's `currentTime`. SkipDB reports milliseconds. */
  start: number;
  end: number;
  /** SkipDB's 0…1 confidence for the segment; 1 where it says nothing. */
  confidence: number;
}

/** What a Skip button says for each kind — the same words the Apple TV uses. */
export const SKIP_LABEL: Record<SkipKind, string> = {
  intro: 'Skip Intro',
  recap: 'Skip Recap',
  outro: 'Skip Credits',
  preview: 'Skip Preview',
};

/** Intro and recap win a tie over a preview, as on the TV; they do not overlap in practice. */
const KINDS: SkipKind[] = ['intro', 'recap', 'outro', 'preview'];

/**
 * The confidence an automatic skip needs.
 *
 * SkipDB scores a segment by how well its community times fit THIS encode: 0.9 where the runtime matched
 * exactly, 0.82 where it was within about ten seconds and the times were shifted to fit, and 0.75 where no
 * runtime was sent and the times are the reference encode's, unadjusted. A button offering a skip a few seconds
 * off costs a press; jumping there unasked costs the viewer the end of the episode. The tvOS app draws the line
 * in the same place (`SkipSegment.autoSkipConfidence`), and the two must agree or the same release behaves
 * differently on the TV and in the browser.
 */
export const AUTO_SKIP_CONFIDENCE = 0.8;

/** Whether this segment may be skipped without the viewer asking. Below the bar it still offers its button. */
export const canAutoSkip = (segment: SkipSegment): boolean =>
  segment.confidence >= AUTO_SKIP_CONFIDENCE;

/** The segment under the playhead, if any — what a Skip button should offer. */
export function activeAt(segments: readonly SkipSegment[], time: number): SkipSegment | null {
  return segments.find((one) => time >= one.start && time < one.end) ?? null;
}

interface Answer {
  segments: SkipSegment[];
  /** Whether SkipDB named any segment at all, however it matched — see `fetchSkipSegments`. */
  named: boolean;
}

function parse(body: unknown): Answer {
  const raw = (body as { segments?: Record<string, unknown> } | null)?.segments;
  if (!raw || typeof raw !== 'object') return { segments: [], named: false };
  let named = false;
  const segments: SkipSegment[] = [];
  for (const kind of KINDS) {
    const one = raw[kind] as Record<string, unknown> | null | undefined;
    if (!one) continue;
    named = true;
    // `out-of-range` times are deliberately left unadjusted: SkipDB declined to fit them to this encode, so
    // acting on them would skip to the wrong place. Dropping them is what makes the retry below worth making.
    if (one.match === 'out-of-range') continue;
    const start = Number(one.start_ms);
    const end = Number(one.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const confidence = Number(one.confidence);
    segments.push({
      kind,
      start: start / 1000,
      end: end / 1000,
      confidence: Number.isFinite(confidence) ? confidence : 1,
    });
  }
  return { segments, named };
}

async function ask(path: string, signal: AbortSignal | undefined, fetchImpl: typeof fetch) {
  try {
    const res = await fetchImpl(path, { signal, headers: { accept: 'application/json' } });
    // A miss is a normal empty result, never an error: skip is an enhancement, not a required path.
    if (!res.ok) return null;
    return parse((await res.json()) as unknown);
  } catch {
    return null;
  }
}

/**
 * The skip segments for what is playing, best aligned to this release.
 *
 * The runtime is sent because SkipDB aligns its community times to the encode you name. For an arbitrary
 * release that runtime is routinely more than ten seconds from the encode the community timed, and SkipDB then
 * answers `out-of-range` with the times unadjusted — which `parse` drops, leaving nothing. So an answer that
 * HELD segments and lost every one of them is asked again with no runtime, which returns the reference times as
 * `agnostic`: worth a button, and too uncertain to fire on their own (`canAutoSkip`).
 *
 * Only that case. A title SkipDB knows nothing about would otherwise be asked for twice every time it played.
 */
export async function fetchSkipSegments(
  imdb: string,
  {
    season,
    episode,
    durationSeconds,
    signal,
    fetchImpl = fetch,
  }: {
    season?: number;
    episode?: number;
    durationSeconds?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SkipSegment[]> {
  const episodePath = season !== undefined && episode !== undefined ? `/${season}/${episode}` : '';
  const base = `/skipdb/${encodeURIComponent(imdb)}${episodePath}`;
  const runtime =
    durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds)
      : undefined;

  const aligned = await ask(runtime ? `${base}?duration=${runtime}` : base, signal, fetchImpl);
  if (aligned?.segments.length || !runtime || !aligned?.named) return aligned?.segments ?? [];
  return (await ask(base, signal, fetchImpl))?.segments ?? [];
}
