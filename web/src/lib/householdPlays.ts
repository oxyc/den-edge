// A TV's household queue (den-spec inbox-v1 §5) from the receiving side: the play key this TV publishes as
// `<d>.play`, and the plays any device holding the library sends to it. Only the TV build loads this.

import { hex } from './crypto';
import { drainPlays, type PlayRequest } from './inbox';
import { toBase64url } from './wire';

const KEY = 'den.tvPlayKey.v1';
/** How long den-edge may hold a drain for a message to land (inbox-v1 §3 allows 25). */
const WAIT_S = 25;
/** The least time between two drains: an early empty answer must not be followed straight away by another. */
const DRAIN_GAP_MS = 5_000;
/** After a refused or failed drain. */
const RETRY_MS = 15_000;
/** Before this TV has published a play key, there is nothing to drain yet. */
const IDLE_MS = 10_000;

/** A short, one-way tag of the library key, so a stored play key can say which library it was made for. */
async function libraryTag(libraryKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(libraryKey));
  return hex(new Uint8Array(digest).slice(0, 16));
}

function stored(storage: Storage | undefined): { library: string; key: string } | null {
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) ?? 'null') as {
      library?: unknown;
      key?: unknown;
    } | null;
    return typeof parsed?.library === 'string' &&
      typeof parsed.key === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(parsed.key)
      ? { library: parsed.library, key: parsed.key }
      : null;
  } catch {
    return null;
  }
}

/**
 * This TV's household play key for the library `libraryKey` opens. Kept for that library and made anew when the
 * library key changes (inbox-v1 §5): a device shut out by a reset still knows the old one, and rows can carry the old
 * `<d>.play` into the new library, so the published key is not the one to trust.
 */
export async function playKeyFor(
  libraryKey: string,
  storage: Storage | undefined = globalThis.localStorage,
): Promise<string> {
  const library = await libraryTag(libraryKey);
  const kept = stored(storage);
  if (kept?.library === library) return kept.key;
  const key = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    storage?.setItem(KEY, JSON.stringify({ library, key }));
  } catch {
    // Without site data the key lasts this visit: the next check-in publishes a new one, and senders read that.
  }
  return key;
}

/** The play key this TV last made, whichever profile is active now. */
export const currentPlayKey = (
  storage: Storage | undefined = globalThis.localStorage,
): string | undefined => stored(storage)?.key;

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Drain this TV's household queue until `signal` aborts. The newest fresh play of a drain (the queue keeps arrival
 * order) goes to `play`, since several in one drain would only replace each other; each play that waited too long
 * goes to `stale`, and never starts.
 */
export async function receivePlays(
  handlers: { play: (play: PlayRequest) => Promise<void>; stale: (play: PlayRequest) => void },
  signal: AbortSignal,
  storage: Storage | undefined = globalThis.localStorage,
): Promise<void> {
  while (!signal.aborted) {
    const key = currentPlayKey(storage);
    if (!key) {
      await pause(IDLE_MS, signal);
      continue;
    }
    const started = Date.now();
    const drained = await drainPlays(key, { wait: WAIT_S, storage }).catch(() => null);
    if (signal.aborted) return;
    if (drained) {
      for (const play of drained.stale) handlers.stale(play);
      const newest = drained.fresh.at(-1);
      if (newest) await handlers.play(newest).catch(() => undefined);
    }
    await pause(drained ? Math.max(0, DRAIN_GAP_MS - (Date.now() - started)) : RETRY_MS, signal);
  }
}
