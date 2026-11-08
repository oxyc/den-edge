export type CastIdleAction = 'finished' | 'error' | 'replaced' | 'stopped' | 'pending';
export type CastErrorAction = 'retry-receiver' | 'stop-receiver';

/**
 * Interpret the idle reason carried by the Cast media session, not by RemotePlayer. IDLE with no reason is a receiver
 * that has not reported on the media it was just handed (no media session yet, or none of its status): nothing ended.
 * Read as "stopped", it ended the Cast session the moment a load was accepted, and the TV went back to its home screen.
 */
export function castIdleAction(
  reason: string | null | undefined,
  replacing: boolean,
): CastIdleAction {
  if (reason == null) return 'pending';
  if (reason === 'FINISHED') return 'finished';
  if (reason === 'ERROR') return 'error';
  if (reason === 'INTERRUPTED' && replacing) return 'replaced';
  return 'stopped';
}

/** What the bar says while the video plays in this browser: the default, and what Cast falls back to when it ends. */
export const PLAYING_HERE = 'Playing on this device';

/** Whether the text is worth putting over the video: not when it only repeats what the picture already shows. */
export function statusShown(text: string): boolean {
  return text !== '' && text !== PLAYING_HERE;
}

/** What the pill says while a Cast receiver plays it, so it is never unclear where the picture is. */
export function castingTo(device: string | null | undefined): string {
  return `Casting to ${device?.trim() || 'your TV'}`;
}

/** Keep the Cast session for one conservative retry, then end it if that fallback also fails. */
export function castErrorAction(terminal: boolean): CastErrorAction {
  return terminal ? 'stop-receiver' : 'retry-receiver';
}
