export type PlaybackReceiptPreparation = 'ready' | 'temporarily-unavailable' | 'unsupported';

/** A build capability: unsupported old-engine packages must not start receipt crypto or network work. */
export const playbackReceiptsSupported = __DEN_MANAGED_PLAYBACK_RECEIPTS__;

/**
 * Keep the permanent build exclusion ahead of the lazy module boundary. `prepare` owns the capable build's import
 * and authority call; an unsupported build never invokes it, so queued work remains untouched for another device.
 */
export async function preparePlaybackReceiptCapability<Authority>({
  supported,
  authority,
  signal,
  prepare,
}: {
  supported: boolean;
  authority: Authority | null;
  signal: AbortSignal;
  prepare: (authority: Authority, signal: AbortSignal) => Promise<boolean>;
}): Promise<PlaybackReceiptPreparation> {
  if (!supported) return 'unsupported';
  if (!authority || signal.aborted) return 'temporarily-unavailable';
  const ready = await prepare(authority, signal);
  return ready && !signal.aborted ? 'ready' : 'temporarily-unavailable';
}
