// One answer for everyone asking the same question at about the same time.
//
// A service page is asked for twice: once when a pointer rests on its tile (`primeServicePage`), and again when the
// page mounts. Both must share the same requests rather than race each other to the network, and a page opened again
// a minute later should paint from what it already has.

/** How long an answer is shared. Charts and directories change daily at most; a visit is minutes. */
export const REUSE_MS = 5 * 60_000;

const held = new Map<string, { at: number; value: Promise<unknown> }>();

/**
 * `make()`'s promise, shared by every caller asking under `key` within `REUSE_MS`. A failure is not kept: the next
 * caller asks again rather than being handed the same refusal for five minutes.
 */
export function reuse<T>(
  key: string,
  make: () => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const kept = held.get(key);
  if (kept && now - kept.at < REUSE_MS) return kept.value as Promise<T>;
  const value = make();
  held.set(key, { at: now, value });
  value.catch(() => {
    if (held.get(key)?.value === value) held.delete(key);
  });
  return value;
}

/** Forget everything shared: for tests, which ask the same questions of different fakes. */
export function forgetReused(): void {
  held.clear();
}
