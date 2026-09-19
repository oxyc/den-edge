const BYTES = 2 * 1024 * 1024;
const SKIP_MS = 150;
const READ_MS = 4_000;
const DEADLINE_MS = 10_000;
const HEADROOM = 0.7;
const MIN_PLAYABLE_BITRATE = 64_000;

export function usableLinkLimit(value: number | undefined): number | undefined {
  return value !== undefined && value >= MIN_PLAYABLE_BITRATE ? value : undefined;
}

/** Measure only the signed URL handed over by Den. This runs on the keyless Cast origin, whose CSP may reach it. */
export async function signedLinkLimit(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  let first: number | undefined;
  let mark: number | undefined;
  let last: number | undefined;
  let total = 0;
  let counted = 0;
  try {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetchImpl(
      url.includes('bytes=') ? url : `${url}${separator}bytes=${BYTES}`,
      { cache: 'no-store', signal: controller.signal },
    );
    if (!response.ok || !response.body) return undefined;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const at = now();
      first ??= at;
      last = at;
      total += value.byteLength;
      if (at - first <= SKIP_MS) mark = at;
      else counted += value.byteLength;
      if (at - first >= READ_MS) {
        void reader.cancel();
        break;
      }
    }
  } catch {
    // An interrupted sample may still contain enough timed bytes below.
  } finally {
    clearTimeout(timer);
  }
  if (first === undefined || last === undefined) return undefined;
  const rate =
    counted > 0 && mark !== undefined
      ? (counted * 8000) / (last - mark)
      : last > first
        ? (total * 8000) / (last - first)
        : 0;
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return Math.min(1_000_000_000, Math.round(rate * HEADROOM));
}
