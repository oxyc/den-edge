// A TV's queues from the receiving side: the household play key it publishes as `<d>.play` (den-spec inbox-v1 §5),
// the plays any device holding the library sends to it, and the transport commands of the browser that paired it.
// Only the TV build loads this.

import { hex } from './crypto';
import { drainTv, type PlayRequest, type TransportCommand } from './inbox';
import type { Link } from './links.svelte';
import { toBase64url } from './wire';

const KEY = 'den.tvPlayKey.v1';
/** How long den-edge may hold a drain for a message to land (inbox-v1 §3 allows 25). */
const WAIT_S = 25;
/** The least time between two drains: an early empty answer must not be followed straight away by another. */
const DRAIN_GAP_MS = 5_000;
/** After a refused or failed drain. */
const RETRY_MS = 15_000;
/** With neither a play key nor a pairing link yet, there is nothing to drain. */
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
 * Drain this TV's queues until `signal` aborts, both in one held request: its household queue and the queue of the
 * link that paired it (`link`, read again each round). The newest fresh play of a drain (the queue keeps arrival order)
 * goes to `play`, since several in one drain would only replace each other; each play that waited too long goes to
 * `stale`, and never starts; transport commands go to `transport` in order.
 */
export async function receiveTv(
  handlers: {
    play: (play: PlayRequest) => Promise<void>;
    stale: (play: PlayRequest) => void;
    transport: (command: TransportCommand) => void;
  },
  link: () => Pick<Link, 'inboxKey' | 'linkKey'> | null | undefined,
  signal: AbortSignal,
  storage: Storage | undefined = globalThis.localStorage,
): Promise<void> {
  while (!signal.aborted) {
    const playKey = currentPlayKey(storage);
    const paired = link() ?? undefined;
    if (!playKey && !paired) {
      await pause(IDLE_MS, signal);
      continue;
    }
    const started = Date.now();
    const drained = await drainTv({ playKey, link: paired }, { wait: WAIT_S, storage }).catch(
      () => null,
    );
    if (signal.aborted) return;
    if (!drained) {
      await pause(RETRY_MS, signal);
      continue;
    }
    for (const play of drained.stale) handlers.stale(play);
    for (const command of drained.transport) handlers.transport(command);
    const newest = drained.fresh.at(-1);
    if (newest) await handlers.play(newest).catch(() => undefined);
    // An empty answer that came early (no held drains on this den-edge, or its cap on them reached) must not be
    // followed straight away by another (inbox-v1 §3). One that brought something drains again at once.
    const empty = !drained.fresh.length && !drained.stale.length && !drained.transport.length;
    if (empty) await pause(Math.max(0, DRAIN_GAP_MS - (Date.now() - started)), signal);
  }
}
