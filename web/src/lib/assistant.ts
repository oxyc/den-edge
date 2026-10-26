// Assistant writes (den-spec wire/assistant-v1.md): an assistant connected through den-mcp seals requests to change
// the library into den-edge's queue; this browser, while a member's library is open here, drains them, has the
// library service open and check each one with den-core, applies the accepted ones through the same path a tap
// takes, and acknowledges them. den-edge holds only the drop-box public key and opaque requests. An LG or Samsung TV
// also drains its own lane of the TV queue (§16), whose plays it starts rather than applies.

import { exclusive } from './exclusive';
import { listConnections } from './oauth';
import { relayFetch } from './relayFetch';

/**
 * §5 *Renewal*: the grants whose connection den-edge still lists, handed to the library service to renew (it renews
 * at most once a day). A grant whose connection is gone is left to expire.
 */
export async function renewListed(
  renew: (grants: string[]) => Promise<unknown>,
  fetchImpl: typeof fetch = relayFetch,
): Promise<void> {
  const listed = await listConnections(fetchImpl);
  if (!listed.ok) return;
  const grants = listed.value.flatMap((c) => (c.grant && c.kind === 'member' ? [c.grant] : []));
  if (grants.length) await renew(grants);
}

/** One waiting request, as den-edge hands it out. */
export interface QueuedRequest {
  seq: number;
  sealed: string;
}

/** A drop-box public key, as `assistant_dropbox` names it. */
export interface DropboxKey {
  kid: string;
  public: string;
}

/** What the library service made of a drain. */
export interface ApplyOutcome {
  /** Per request, in the order handled: applied (with what it did), or refused with den-core's reason. */
  results: ApplyResult[];
  /** The highest `seq` to acknowledge, or null when nothing handled may be acknowledged yet. */
  ack: number | null;
  /** The drop-box key den-edge should hold for this library, or null when it has none. */
  dropbox: DropboxKey | null;
}

export type ApplyResult =
  | {
      seq: number;
      outcome: 'accepted';
      op: string;
      title: { type: 'movie' | 'tv'; id: number };
      /** A play's episode (§16), when it names one. */
      season?: number;
      episode?: number;
      detail: string;
    }
  | { seq: number; outcome: 'rejected'; reason: string };

/** A held drain's wait, in seconds (den-edge holds at most 25). */
const WAIT_S = 25;
/** A drain may take its wait and then some: den-edge answers within `WAIT_S`, and the network adds to it. */
const DRAIN_MS = (WAIT_S + 15) * 1000;
/** Between drains when den-edge answered at once with nothing, or could not be reached. */
const IDLE_MS = 15_000;
const BACKOFF_MS = 60_000;

export async function putDropbox(
  key: DropboxKey,
  fetchImpl: typeof fetch = relayFetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl('/assistant/dropbox', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pk: key.public }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A queue other than the library's: a TV's lane of the TV queue (§16), described by the TV-only code that drains it
 * (`householdPlays.laneQueue`) so none of it ships to a browser.
 */
export interface OtherQueue {
  /** Its query parameters, without `wait`. */
  query: string;
  /** The drain's JSON body. */
  body: string;
  /** Appended to the drain's lock name. */
  key: string;
}

/** Every waiting request, oldest first; null when den-edge refused or could not be reached. */
export async function drainQueue(
  wait: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
  queue?: OtherQueue,
): Promise<QueuedRequest[] | null> {
  const query = [queue?.query, wait > 0 ? `wait=${wait}` : ''].filter(Boolean).join('&');
  try {
    const res = await fetchImpl(`/assistant/drain${query ? `?${query}` : ''}`, {
      method: 'POST',
      cache: 'no-store',
      ...(queue ? { headers: { 'content-type': 'application/json' }, body: queue.body } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(DRAIN_MS)]),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) return null;
    return body.messages.flatMap((m: { seq?: unknown; sealed?: unknown }) =>
      Number.isSafeInteger(m?.seq) && typeof m?.sealed === 'string'
        ? [{ seq: m.seq as number, sealed: m.sealed }]
        : [],
    );
  } catch {
    return null;
  }
}

export async function ackQueue(
  upTo: number,
  fetchImpl: typeof fetch = relayFetch,
  queue?: OtherQueue,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`/assistant/ack${queue ? `?${queue.query}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upTo }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** How often the publisher asks the library service whether a projection is due (§15: it debounces and heartbeats). */
const PUBLISH_TICK_MS = 30_000;

/**
 * §15 *Publishing*: while the library is open, ask the library service every 30 s to send each read grant's
 * projection that is due. One tab of this browser publishes a library at a time (a Web Lock), another taking over
 * when it closes; another device publishing too only replaces it with the same lists.
 */
export function publishWhileOpen(
  loop: {
    libraryId: string;
    publish: () => Promise<unknown>;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
  signal: AbortSignal,
): Promise<void> {
  const sleep = loop.sleep ?? pause;
  return exclusive(`den.assistant.publish.${loop.libraryId}`, async () => {
    while (!signal.aborted) {
      try {
        await loop.publish();
      } catch (error) {
        console.warn('den: assistant projections could not be published', error);
      }
      await sleep(PUBLISH_TICK_MS, signal);
    }
  });
}

export interface DrainLoop {
  libraryId: string;
  /** Drain this queue instead of the library's: a TV's lane (§16). */
  queue?: OtherQueue;
  /** Opens, checks and applies a drain's requests in the library service. */
  apply: (messages: QueuedRequest[]) => Promise<ApplyOutcome>;
  /** Told of each applied request, for the page's quiet toast. */
  applied: (result: Extract<ApplyResult, { outcome: 'accepted' }>) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Drain the library's assistant queue while `signal` stands: at once, then held (`?wait=`). One tab of this browser
 * drains a library at a time (a Web Lock); another takes over when it closes. Another device draining at once is
 * safe — the applied row refuses a request applied already — so the lock only saves the work twice.
 */
export function drainWhileOpen(loop: DrainLoop, signal: AbortSignal): Promise<void> {
  return exclusive(`den.assistant.drain.${loop.libraryId}${loop.queue?.key ?? ''}`, () =>
    drainLoop(loop, signal),
  );
}

async function drainLoop(loop: DrainLoop, signal: AbortSignal): Promise<void> {
  const sleep = loop.sleep ?? pause;
  const fetchImpl = loop.fetchImpl ?? relayFetch;
  /** The drop-box key last given to den-edge in this session; it is given again when the library's changes. */
  let put: string | null = null;
  let wait = 0;
  while (!signal.aborted) {
    const started = Date.now();
    const messages = await drainQueue(wait, signal, fetchImpl, loop.queue);
    if (signal.aborted) return;
    if (messages === null) {
      await sleep(BACKOFF_MS, signal);
      continue;
    }
    let outcome: ApplyOutcome;
    try {
      outcome = await loop.apply(messages);
    } catch (error) {
      console.warn('den: assistant requests could not be applied', error);
      await sleep(BACKOFF_MS, signal);
      continue;
    }
    // The library queue's drain gives den-edge the drop-box key; a lane's leaves that to it.
    if (
      !loop.queue &&
      outcome.dropbox &&
      outcome.dropbox.public !== put &&
      (await putDropbox(outcome.dropbox, fetchImpl))
    )
      put = outcome.dropbox.public;
    for (const result of outcome.results) {
      if (result.outcome === 'accepted') loop.applied(result);
      // The reason, never the request: it is the household's, and a refusal is no error of this page's.
      else console.info(`den: an assistant request was refused (${result.reason})`);
    }
    if (outcome.ack !== null) await ackQueue(outcome.ack, fetchImpl, loop.queue);
    // An empty answer may come early (den-edge was busy, or the hold was refused), and requests left unacknowledged
    // come straight back: never drain again at once.
    const last = messages.at(-1)?.seq;
    const left = last !== undefined && (outcome.ack === null || outcome.ack < last);
    if (left || (!messages.length && Date.now() - started < 1_000)) await sleep(IDLE_MS, signal);
    wait = WAIT_S;
  }
}
