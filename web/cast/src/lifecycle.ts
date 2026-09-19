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

/** What the bar says while the video plays in this browser: the default, and what Cast falls back to when it ends. */
export const PLAYING_HERE = 'Playing on this device';

/** What the bar says while a Cast receiver plays it, so it is never unclear where the picture is. */
export function castingTo(device: string | null | undefined): string {
  return `Casting to ${device?.trim() || 'your TV'}`;
}

/** Keep the Cast session for one conservative retry, then end it if that fallback also fails. */
export function castErrorAction(terminal: boolean): CastErrorAction {
  return terminal ? 'stop-receiver' : 'retry-receiver';
}
