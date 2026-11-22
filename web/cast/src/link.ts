import { linkRate, SPEED_PROBE_BYTES } from '../../src/lib/linkRate';

const READ_MS = 4_000;
const DEADLINE_MS = 10_000;
const HEADROOM = 0.7;
const MIN_PLAYABLE_BITRATE = 64_000;

export function usableLinkLimit(value: number | undefined): number | undefined {
  return value !== undefined && value >= MIN_PLAYABLE_BITRATE ? value : undefined;
}

/**
 * Measure only the signed URL handed over by Den. This runs on the keyless Cast origin, whose CSP may reach it.
 * `answered` is false when no response came within the deadline, as when the public listener drops this browser's
 * packets because it was opened for another address.
 */
export async function signedLinkLimit(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<{ limit: number | undefined; answered: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const chunks: [number, number][] = [];
  let answered = false;
  try {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetchImpl(
      url.includes('bytes=') ? url : `${url}${separator}bytes=${SPEED_PROBE_BYTES}`,
      { cache: 'no-store', signal: controller.signal },
    );
    answered = true;
    if (!response.ok || !response.body) return { limit: undefined, answered };
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const at = now();
      chunks.push([at, value.byteLength]);
      if (at - chunks[0]![0] >= READ_MS) {
        void reader.cancel();
        break;
      }
    }
  } catch {
    // An interrupted sample may still contain enough timed bytes below.
  } finally {
    clearTimeout(timer);
  }
  const rate = linkRate(chunks) ?? 0;
  if (!Number.isFinite(rate) || rate <= 0) return { limit: undefined, answered };
  return { limit: Math.min(1_000_000_000, Math.round(rate * HEADROOM)), answered };
}
