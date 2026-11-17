/** Closed media-engine identities and outcomes. Never add a URL, title id, capability or provider text here. */
export type MediaEngine = 'trailer' | 'hls.js' | 'avplay';
export type MediaEngineOutcome = 'startup' | 'fatal' | 'fragment_loop' | 'exhausted';

/** A thrown value's built-in class, without its freely controlled name, message, stack or fields. */
function errorClass(error: unknown) {
  if (error === undefined) return 'none';
  if (error instanceof TypeError) return 'type_error';
  return 'exception';
}

/** Emit one bounded diagnostic without forwarding engine, browser or transport payloads. */
export function reportMediaEngineFailure(
  engine: MediaEngine,
  outcome: MediaEngineOutcome,
  error?: unknown,
): void {
  console.warn('den: media engine failure', engine, outcome, errorClass(error));
}
