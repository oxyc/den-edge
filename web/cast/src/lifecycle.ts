export type CastIdleAction = 'finished' | 'error' | 'replaced' | 'stopped';
export type CastErrorAction = 'retry-receiver' | 'stop-receiver';

/** Interpret the idle reason carried by the Cast media session, not by RemotePlayer. */
export function castIdleAction(
  reason: string | null | undefined,
  replacing: boolean,
): CastIdleAction {
  if (reason === 'FINISHED') return 'finished';
  if (reason === 'ERROR') return 'error';
  if (reason === 'INTERRUPTED' && replacing) return 'replaced';
  return 'stopped';
}

/** Keep the Cast session for one conservative retry, then end it if that fallback also fails. */
export function castErrorAction(fallback: boolean): CastErrorAction {
  return fallback ? 'stop-receiver' : 'retry-receiver';
}
