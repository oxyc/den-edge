/** Closed trailer-engine outcomes. Never add a URL, title id, capability or provider text here. */
export type TrailerEngineOutcome =
  | 'module_load_failed'
  | 'startup_failed'
  | 'fatal_error'
  | 'fragment_loop'
  | 'candidates_exhausted';

type TrailerEngineErrorClass = 'dom_exception' | 'type_error' | 'error' | 'response' | 'other';

/** A thrown value's built-in class, without its freely controlled name, message, stack or fields. */
function errorClass(error: unknown): TrailerEngineErrorClass {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return 'dom_exception';
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof Error) return 'error';
  if (typeof Response !== 'undefined' && error instanceof Response) return 'response';
  return 'other';
}

/** Emit one bounded diagnostic without forwarding hls.js, browser or transport payloads. */
export function reportTrailerEngineFailure(outcome: TrailerEngineOutcome, error?: unknown): void {
  const classified = error === undefined ? '' : `,"errorClass":"${errorClass(error)}"`;
  console.warn(`[Den trailer] {"event":"engine-failure","outcome":"${outcome}"${classified}}`);
}

interface TrailerEngineFailureOwner {
  /** Whether this engine still owns the mounted media attempt. */
  current: () => boolean;
  /** Retire ownership synchronously before an engine can emit a duplicate terminal event. */
  retire: () => void;
  stop: () => void;
  advance: () => void;
}

interface HlsErrorData {
  fatal: boolean;
}

interface HlsFragmentData {
  frag: { type: string; level: number; sn: number | string };
}

/** How often hls.js may fetch one fragment before the attempt is terminal. */
export const MOST_TRAILER_FRAGMENT_LOADS = 4;

/**
 * The production hls.js terminal-event state machine. Keeping it here makes its one-shot ownership, fallback and
 * privacy contract testable without mounting a decoder or forwarding hls.js's unbounded event payloads.
 */
export function trailerEngineFailureHandlers(owner: TrailerEngineFailureOwner): {
  error: (_event: unknown, data: HlsErrorData) => void;
  fragmentLoading: (_event: unknown, data: HlsFragmentData) => void;
} {
  const loads = new Map<string, number>();
  const fail = (outcome: 'fatal_error' | 'fragment_loop', stop: boolean) => {
    if (!owner.current()) return;
    owner.retire();
    reportTrailerEngineFailure(outcome);
    if (stop) owner.stop();
    owner.advance();
  };
  return {
    error: (_event, data) => {
      if (data.fatal) fail('fatal_error', false);
    },
    fragmentLoading: (_event, { frag }) => {
      const key = `${frag.type}:${frag.level}:${frag.sn}`;
      const count = (loads.get(key) ?? 0) + 1;
      loads.set(key, count);
      if (count > MOST_TRAILER_FRAGMENT_LOADS) fail('fragment_loop', true);
    },
  };
}

/**
 * Keep module loading and synchronous engine startup as distinct closed outcomes. The caller owns whether
 * advancing is still live, so teardown can make the fallback a no-op without leaking the rejected value.
 */
export async function startTrailerEngine<T>(
  load: () => Promise<T>,
  start: (loaded: T) => void,
  advance: () => void,
  current: () => boolean = () => true,
): Promise<void> {
  let loaded: T;
  try {
    loaded = await load();
  } catch (error) {
    if (!current()) return;
    reportTrailerEngineFailure('module_load_failed', error);
    advance();
    return;
  }
  if (!current()) return;
  try {
    start(loaded);
  } catch (error) {
    if (!current()) return;
    reportTrailerEngineFailure('startup_failed', error);
    advance();
  }
}
