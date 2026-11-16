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
  console.warn(
    `[Den trailer] ${JSON.stringify({
      event: 'engine-failure',
      outcome,
      ...(error === undefined ? {} : { errorClass: errorClass(error) }),
    })}`,
  );
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
