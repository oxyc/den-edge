export type CastIdleAction = 'finished' | 'error' | 'replaced' | 'stopped';

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
