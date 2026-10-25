/** The bounded recovery for an externally managed HLS result. Remux keeps its existing recovery. */
export function directRecovery(
  _played: boolean,
  attempt: 'initial' | 'refreshed',
): 'refresh' | 'stop' {
  return attempt === 'initial' ? 'refresh' : 'stop';
}
