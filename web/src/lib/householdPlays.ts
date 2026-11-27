// A TV's household command queue from the receiving side: the key it publishes as `<d>.play` (the compatibility
// field name in den-spec inbox-v1 §5), and the plays and transport commands any device holding the library sends.
// Only the TV build loads this.

import type { OtherQueue } from './assistant';
import { abortableDelay } from './abortableDelay';
import { hex, hkdf } from './crypto';
import { drainTv, type PlayRequest, type TransportCommand } from './inbox';
import { reportResult } from './playResults';
import { fromBase64url, toBase64url } from './wire';

const KEY = 'den.tvPlayKey.v1';
/** How long den-edge may hold a drain for a message to land (inbox-v1 §3 allows 25). */
const WAIT_S = 25;
/** The least time between two drains: an early empty answer must not be followed straight away by another. */
const DRAIN_GAP_MS = 5_000;
/** After a refused or failed drain. */
const RETRY_MS = 15_000;
const FOREVER_MS = 0x7fffffff;

interface VisitKey {
  library: string;
  key: string;
}
let visit: VisitKey | undefined;
let source: string | undefined;
let changed = new AbortController();

function siteStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function retire(): void {
  changed.abort();
  changed = new AbortController();
  visit = undefined;
}

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

function persist(storage: Storage | undefined, library: string, key: string): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ library, key }));
  } catch {
    // The visit copy still feeds check-in and both receivers; a later check-in retries it without rotation.
  }
}

/**
 * This TV's household play key for the library `libraryKey` opens. Kept for that library and made anew when the
 * library key changes (inbox-v1 §5): a device shut out by a reset still knows the old one, and rows can carry the old
 * `<d>.play` into the new library, so the published key is not the one to trust.
 */
export async function playKeyFor(
  libraryKey: string,
  storage: Storage | undefined = siteStorage(),
): Promise<string> {
  if (source !== libraryKey) {
    source = libraryKey;
    retire();
  }
  const authority = changed;
  const library = await libraryTag(libraryKey);
  const current = visit;
  if (source !== libraryKey || (changed !== authority && current?.library !== library))
    throw new DOMException('play key authority changed', 'AbortError');
  const kept = stored(storage);
  if (current?.library === library) {
    if (kept?.library === library && kept.key === current.key) return current.key;
    persist(storage, library, current.key);
    return current.key;
  }
  const key =
    kept?.library === library ? kept.key : toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  retire();
  visit = { library, key };
  persist(storage, library, key);
  return key;
}

/**
 * Run `use` for each visit key while it remains current. A household replacement aborts the old work before the new
 * key is exposed; a same-household profile replacement keeps the key and work intact.
 */
export async function whilePlayKey(
  use: (key: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const current = visit;
    if (!current) {
      await abortableDelay(FOREVER_MS, signal, changed.signal);
      continue;
    }
    const active = AbortSignal.any([signal, changed.signal]);
    try {
      await use(current.key, active);
    } catch (error) {
      if (!active.aborted) throw error;
    }
    if (!active.aborted) await abortableDelay(FOREVER_MS, active);
  }
}

/**
 * This TV's lane of the assistant's TV queue (den-spec assistant-v1 §16 *TV lanes*): derived from its play key, so it
 * is made anew with it and says nothing of the library or the device.
 */
export async function laneId(playKey: string): Promise<string> {
  return hex(await hkdf(fromBase64url(playKey), 'den/link/v1', 'assistant-tv', 16));
}

/**
 * The lane as the assistant drain loop takes it: drained under this TV's name, so den-mcp can ask for it by name, and
 * saying this TV reports play results (play-results-v1 §6), so den-mcp waits for them.
 */
export async function laneQueue(playKey: string, name: string): Promise<OtherQueue> {
  const id = await laneId(playKey);
  return {
    query: `queue=tv&tv=${id}`,
    body: JSON.stringify({ name, results: 1 }),
    key: `.tv.${id}`,
  };
}

/** When this TV last woke or came to the foreground: a play sent before that never starts (§16 *Freshness*). */
let awake = Date.now();
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') awake = Date.now();
  });
export const awakeSince = () => awake;

/** A play for this TV, and whether it is the title's trailer rather than the title. */
export type TvPlay = PlayRequest & { trailer?: boolean };
let starter: ((play: TvPlay) => Promise<void>) | null = null;

/**
 * The page that can start a play on this TV registers here, so a play from the assistant's lane starts through the same
 * path as one from the household queue. Returns its unregistering.
 */
export function startPlaysWith(start: (play: TvPlay) => Promise<void>): () => void {
  starter = start;
  return () => {
    if (starter === start) starter = null;
  };
}

/**
 * Start `play` through the registered page; false when none is open to start it, which its requester hears as a
 * failure (play-results-v1 §3).
 */
export async function startPlay(play: TvPlay): Promise<boolean> {
  if (!starter) {
    if (play.id) void reportResult(play.id, { state: 'failed', reason: 'failed' });
    return false;
  }
  await starter(play);
  return true;
}

/**
 * Drain this TV's household command queue until `signal` aborts. The newest fresh play of a drain (the queue keeps
 * arrival order) goes to `play`, since several in one drain would only replace each other; each play that waited too
 * long goes to `stale`, and never starts; transport commands go to `transport` in order. The requesters of the plays
 * that never start hear why (play-results-v1 §4): `expired`, or `superseded` by the newest.
 */
export async function receiveTv(
  handlers: {
    play: (play: PlayRequest) => Promise<void>;
    stale: (play: PlayRequest) => void;
    transport: (command: TransportCommand) => void;
  },
  signal: AbortSignal,
  storage: Storage | undefined = siteStorage(),
): Promise<void> {
  await whilePlayKey(async (playKey, active) => {
    while (!active.aborted) {
      const started = Date.now();
      const drained = await drainTv({ playKey }, { wait: WAIT_S, storage, signal: active }).catch(
        () => null,
      );
      if (active.aborted) return;
      if (!drained) {
        await abortableDelay(RETRY_MS, active);
        continue;
      }
      for (const play of drained.stale) {
        handlers.stale(play);
        if (play.id) void reportResult(play.id, { state: 'failed', reason: 'expired' });
      }
      for (const command of drained.transport) handlers.transport(command);
      const newest = drained.fresh.at(-1);
      for (const replaced of drained.fresh.slice(0, -1))
        if (replaced.id) void reportResult(replaced.id, { state: 'failed', reason: 'superseded' });
      if (newest) await handlers.play(newest).catch(() => undefined);
      // An empty answer that came early (no held drains on this den-edge, or its cap on them reached) must not be
      // followed straight away by another (inbox-v1 §3). One that brought something drains again at once.
      const empty = !drained.fresh.length && !drained.stale.length && !drained.transport.length;
      if (empty) await abortableDelay(Math.max(0, DRAIN_GAP_MS - (Date.now() - started)), active);
    }
  }, signal);
}
