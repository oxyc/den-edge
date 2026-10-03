// The one status line `Player.svelte` shows while a session is still starting (den-edge#234): never a
// percentage or bar den-remux didn't give — only how long this browser has waited, and what is actually known
// of the release. Honest about uncertainty rather than inventing a number: den-remux's own `prebuffer` (a real
// seconds-to-buffer figure it computed) is quoted once a session gives one; short of that, the only truthful
// ceiling available is the budget den-remux and this page already enforce (`PICK_BUDGET` in den-remux's
// session.rs, `REMUX_ANSWER_MS` here), which is what "up to half a minute" quotes — not a guess.

/** Where the wait currently is: no session yet, a session holding for a measured head start, or a session with
 * no (or a short) hold still waiting for its first frame. */
export type Phase = 'session' | 'buffering' | 'starting';

export interface NoticeRelease {
  label: string;
  /** Bytes; absent or null where den-remux hasn't said. */
  size?: number | null;
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

/** den-remux only sends a release's size at all for one worth mentioning by size — see den-edge#234's "Findings". */
export const LARGE_RELEASE_BYTES = 20 * 1024 ** 3;

/** A hold shorter than this is not worth a countdown: the session's own first segment arrives about as fast. */
const COUNTDOWN_FROM_SECS = 3;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function startupNotice(
  elapsedMs: number,
  phase: Phase,
  release?: NoticeRelease,
  /** Seconds left of den-remux's own `prebuffer` hold; only meaningful when `phase` is `'buffering'`. */
  countdownSecs?: number,
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
  const large = !!release?.size && release.size >= LARGE_RELEASE_BYTES;
  return {
    text: large
      ? `Starting ${label}… This is a large release (${formatSize(release!.size!)}) — it can take up to half a minute.`
      : `Starting ${label}…`,
    clock: elapsedMs >= NOTICE_DELAY_MS ? formatClock(elapsedMs) : undefined,
  };
}
