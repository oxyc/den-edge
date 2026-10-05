// The one status line `Player.svelte` shows while a session is still starting (den-edge#234): never a bare
// spinner, and never a percentage or bar den-remux didn't give — only what is actually known. Before a session
// exists, that's the elapsed time alone. Once one does, den-remux's own `prebuffer` (a real seconds-to-buffer
// figure it computes from the link rate it was told and the release's bitrate — never from measured buffering;
// see den-edge#234's "Findings") is quoted when it gives one; short of that, real bytes arriving — hls.js's
// `FRAG_LOADED`, or `buffered` on native HLS where there is no byte loader to read — drive a live "Buffering…"
// line with a rate and, once there's a target to measure against, an ETA labelled as an estimate. Only once
// nothing at all is known yet does the line fall back to the sourced ceiling ("up to half a minute" is den-
// remux's own `PICK_BUDGET`/this page's `REMUX_ANSWER_MS`, not a guess) rather than inventing a number.

/** Where the wait currently is: no session yet, a session holding for a measured head start, or a session with
 * no (or a short) hold still waiting for its first frame. */
export type Phase = 'session' | 'buffering' | 'starting';

export interface NoticeRelease {
  label: string;
  /** Bytes; absent or null where den-remux hasn't said. */
  size?: number | null;
}

/**
 * What has actually arrived toward the first frame, for the `'starting'` phase's live line. hls.js gives real
 * bytes and, once `FRAG_LOADED` has fired more than once, a rate; native HLS (no loader to read) gives only
 * `buffered` seconds. All optional: before anything has arrived, there is nothing to show yet.
 */
export interface Progress {
  /** Bytes fetched toward the first frame so far (hls.js only). */
  bytesLoaded?: number;
  /** Bytes den-remux's own byte index says the first segment is (hls.js, and only with a byte index). */
  bytesTarget?: number;
  /** The measured download rate, once there is enough of a sample to trust it (hls.js only). */
  bitsPerSecond?: number;
  /** Seconds of video buffered ahead of the play head — native HLS's only signal; hls.js gives bytes instead. */
  bufferedSecs?: number;
}

export interface Notice {
  /** The line in `role="status"`, replaced whole on every real change. */
  text: string;
  /** The release, shown under `text` once known — kept out of `text` so it isn't re-announced every tick. */
  sub?: string;
  /** A quiet running clock beside `text`; the caller renders it `aria-hidden`. */
  clock?: string;
}

/** Below this, the generic "Finding a release…" line stands; past it there's enough wait to say more. */
export const NOTICE_DELAY_MS = 4_000;

/** Above this, "Starting <label>…" (before any progress has arrived) names the release's own size. */
export const LARGE_RELEASE_BYTES = 20 * 1024 ** 3;

/** A hold shorter than this is not worth a countdown: the session's own first segment arrives about as fast. */
const COUNTDOWN_FROM_SECS = 3;
/** An ETA under this is not worth saying: it would be gone by the time it was read. */
const ETA_FROM_SECS = 1;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatMB(bytes: number): string {
  return (bytes / 1024 ** 2).toFixed(1);
}

/** `8s`, or `1:30` past a minute: an ETA is read once, not ticked, so it skips the clock's always-two-digit form. */
function formatEta(secs: number): string {
  const whole = Math.ceil(secs);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The live "Buffering…" line once anything has arrived; null while `progress` says nothing yet. */
function bufferingLine(label: string, progress: Progress | undefined): string | null {
  if (progress?.bytesLoaded) {
    const loadedMB = formatMB(progress.bytesLoaded);
    const targetMB = progress.bytesTarget ? formatMB(progress.bytesTarget) : undefined;
    const rateMBps =
      progress.bitsPerSecond && progress.bitsPerSecond > 0
        ? progress.bitsPerSecond / 8 / 1024 ** 2
        : undefined;
    let text = `Buffering ${label} — ${loadedMB}${targetMB ? ` of ${targetMB}` : ''} MB`;
    if (rateMBps) text += ` (${rateMBps.toFixed(1)} MB/s)`;
    if (targetMB && rateMBps) {
      const remainingMB = Math.max(0, Number(targetMB) - Number(loadedMB));
      const etaSecs = remainingMB / rateMBps;
      if (etaSecs > ETA_FROM_SECS) text += ` — ~${formatEta(etaSecs)} left (estimate)`;
    }
    return text;
  }
  if (progress?.bufferedSecs)
    return `Buffering ${label} — ${progress.bufferedSecs.toFixed(1)}s buffered`;
  return null;
}

/**
 * The live line over a stall once a frame has already shown (den-edge#275): the same link data `weighDelivery`
 * already measures — `meter`'s rate and the seconds buffered ahead of the play head — read here only to tell
 * the viewer rather than to decide anything. Never a bare spinner, same as the startup line above it.
 * `gaveUp` is true once no other release fit the link either, so the line says play carries on rather than
 * implying a switch is still coming; a switch actually under way shows `autoSwitchNotice` instead, not this.
 */
export function bufferingWhilePlaying(
  progress: { bufferedSecs?: number; bitsPerSecond?: number } | undefined,
  gaveUp: boolean,
): string {
  const parts: string[] = [];
  if (progress?.bufferedSecs !== undefined)
    parts.push(`${Math.round(progress.bufferedSecs)} s ahead`);
  if (progress?.bitsPerSecond) {
    const rateMBps = progress.bitsPerSecond / 8 / 1024 ** 2;
    parts.push(`downloading at ${rateMBps.toFixed(1)} MB/s`);
  }
  const detail = parts.length ? ` — ${parts.join(', ')}` : '';
  return gaveUp ? `Buffering${detail}. The source is slow right now.` : `Buffering${detail}`;
}

export function startupNotice(
  elapsedMs: number,
  phase: Phase,
  release?: NoticeRelease,
  /** Seconds left of den-remux's own `prebuffer` hold; only meaningful when `phase` is `'buffering'`. */
  countdownSecs?: number,
  /** What has arrived toward the first frame; only meaningful when `phase` is `'starting'`. */
  progress?: Progress,
): Notice {
  if (phase === 'buffering' && countdownSecs !== undefined && countdownSecs > COUNTDOWN_FROM_SECS) {
    return { text: `Starts in ${formatClock(countdownSecs * 1000)}`, sub: release?.label };
  }
  if (phase === 'session') {
    if (elapsedMs < NOTICE_DELAY_MS) return { text: 'Finding a release this browser can play…' };
    return {
      text: 'Opening the release… Large files can take up to half a minute.',
      clock: formatClock(elapsedMs),
    };
  }
  // 'starting', or a 'buffering' hold too short for a countdown: the session exists, its first frame doesn't yet.
  const label = release?.label ?? 'the release';
  const buffering = bufferingLine(label, progress);
  const large = !!release?.size && release.size >= LARGE_RELEASE_BYTES;
  return {
    text:
      buffering ??
      (large
        ? `Starting ${label}… This is a large release (${formatSize(release!.size!)}) — it can take up to half a minute.`
        : `Starting ${label}…`),
    clock: elapsedMs >= NOTICE_DELAY_MS ? formatClock(elapsedMs) : undefined,
  };
}
