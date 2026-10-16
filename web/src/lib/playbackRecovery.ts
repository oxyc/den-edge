/** The bounded recovery for an externally managed HLS result. Remux keeps its existing recovery. */
export function directRecovery(
  played: boolean,
  attempt: 'initial' | 'refreshed',
): 'refresh' | 'fallback' {
  return played && attempt === 'initial' ? 'refresh' : 'fallback';
}
