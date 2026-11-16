/** Closed trailer-engine outcomes. Never add a URL, title id, capability or provider text here. */
export type TrailerEngineOutcome = 'startup' | 'fatal' | 'fragment_loop' | 'exhausted';

/** A thrown value's built-in class, without its freely controlled name, message, stack or fields. */
function errorClass(error: unknown) {
  if (error === undefined) return 'none';
  if (error instanceof TypeError) return 'type_error';
  return 'exception';
}

/** Emit one bounded diagnostic without forwarding hls.js, browser or transport payloads. */
export function reportTrailerEngineFailure(outcome: TrailerEngineOutcome, error?: unknown): void {
  console.warn('den: trailer engine failure', outcome, errorClass(error));
}
