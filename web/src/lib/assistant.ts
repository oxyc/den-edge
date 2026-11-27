// Assistant writes (den-spec wire/assistant-v1.md): an assistant connected through den-mcp seals requests to change
// the library into den-edge's queue; this browser, while a member's library is open here, drains them, has the
// library service open and check each one with den-core, applies the accepted ones through the same path a tap
// takes, and acknowledges them. den-edge holds only the drop-box public key and opaque requests. An LG or Samsung TV
// also drains its own lane of the TV queue (§16), whose plays it starts rather than applies.

import { exclusive } from './exclusive';
import Status from '../components/PlaybackReceiptStatus.svelte';

export { Status };
import { clientFailureErrorClass, reportClientFailure } from './diagnosticsReport';
import { listConnections } from './oauth';
import { relayFetch } from './relayFetch';

/**
 * §5 *Renewal*: the grants whose connection den-edge still lists, handed to the library service to renew (it renews
 * at most once a day). A grant whose connection is gone is left to expire.
 */
export async function renew(
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

type PlaybackReceiptAuthority = {
  ensurePlaybackReceipts(signal?: AbortSignal): Promise<DropboxKey | null>;
};
const preparedReceiptAuthorities = new WeakSet<PlaybackReceiptAuthority>();
const receiptPreparations = new WeakMap<PlaybackReceiptAuthority, Promise<boolean>>();

/** Lazily establish managed-playback completion recovery without adding assistant crypto to app startup. */
export function prepare(
  authority: PlaybackReceiptAuthority,
  signal: AbortSignal,
): Promise<boolean> {
  if (preparedReceiptAuthorities.has(authority)) return Promise.resolve(true);
  const pending = receiptPreparations.get(authority);
  if (pending) return pending;
  const preparation = authority
    .ensurePlaybackReceipts(signal)
    .then((dropbox) => {
      if (!dropbox) return false;
      preparedReceiptAuthorities.add(authority);
      return true;
    })
    .finally(() => receiptPreparations.delete(authority));
  receiptPreparations.set(authority, preparation);
  return preparation;
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

/** The visible result of one bounded managed-playback receipt attempt. */
export type PlaybackReceiptDrainOutcome =
  | { outcome: 'empty' }
  | { outcome: 'completed'; applied: number }
  | { outcome: 'failed'; stage: 'drain' | 'apply' | 'ack' }
  | { outcome: 'retired' };

export type ApplyResult =
  | {
      seq: number;
      outcome: 'accepted';
      op: string;
      title: { type: 'movie' | 'tv'; id: number };
      /** A play's episode (§16), when it names one. */
      season?: number;
      episode?: number;
      /** A play's request id, under which this TV seals its play results (play-results-v1 §1). */
      id?: string;
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
/** A library-service delivery is local, but must still retire if its Worker or port stops answering. */

async function putDropbox(
  key: DropboxKey,
  signal: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl('/assistant/dropbox', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pk: key.public }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
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
async function drainQueue(
  wait: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = relayFetch,
  queue?: OtherQueue,
  endpoint = 'assistant',
): Promise<QueuedRequest[] | null> {
  const query = [queue?.query, wait > 0 ? `wait=${wait}` : ''].filter(Boolean).join('&');
  try {
    const res = await fetchImpl(`/${endpoint}/drain${query ? `?${query}` : ''}`, {
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

async function ackQueue(
  upTo: number,
  fetchImpl: typeof fetch = relayFetch,
  queue?: OtherQueue,
  endpoint = 'assistant',
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`/${endpoint}/ack${queue ? `?${queue.query}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upTo }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Drain opaque Hearth completion receipts once after the library's foreground sync. */
export function one(
  loop: {
    id: string;
    run: (messages: QueuedRequest[]) => Promise<{ ack: number | null; applied?: number }>;
    valid?: () => boolean;
    fetch?: typeof fetch;
  },
  signal: AbortSignal,
): Promise<PlaybackReceiptDrainOutcome> {
  return exclusive(`den.playback-receipts.drain.${loop.id}`, async () => {
    const fetchImpl = loop.fetch ?? relayFetch;
    const messages = await drainQueue(0, signal, fetchImpl, undefined, 'playback/receipts');
    if (signal.aborted) return { outcome: 'retired' };
    if (messages === null) {
      reportClientFailure({
        operation: 'receipt',
        kind: 'transport',
        outcome: 'terminal',
        route: 'receipt_drain',
      });
      return { outcome: 'failed', stage: 'drain' };
    }
    if (!messages.length) return { outcome: 'empty' };
    let result: { ack: number | null; applied?: number };
    try {
      result = await loop.run(messages);
    } catch (error) {
      if (!signal.aborted)
        reportClientFailure({
          operation: 'receipt',
          kind: 'other',
          outcome: 'terminal',
          route: 'receipt_apply',
          errorClass: clientFailureErrorClass(error),
        });
      return signal.aborted ? { outcome: 'retired' } : { outcome: 'failed', stage: 'apply' };
    }
    if (signal.aborted || (loop.valid && !loop.valid())) return { outcome: 'retired' };
    if (result.ack === null) return { outcome: 'failed', stage: 'apply' };
    const ack = result.ack;
    const acknowledged = await ackQueue(ack, fetchImpl, undefined, 'playback/receipts', signal);
    if (signal.aborted || (loop.valid && !loop.valid())) return { outcome: 'retired' };
    if (!acknowledged) {
      if (!signal.aborted)
        reportClientFailure({
          operation: 'receipt',
          kind: 'http',
          outcome: 'terminal',
          route: 'receipt_ack',
        });
      return { outcome: 'failed', stage: 'ack' };
    }
    if (messages.some(({ seq }) => seq > ack)) return { outcome: 'failed', stage: 'apply' };
    return { outcome: 'completed', applied: result.applied ?? 0 };
  });
}

/** Drain one receipt batch only while the same foreground library/profile authority still owns every await. */
export async function current<Connection>(
  loop: {
    id: string;
    key: () => Promise<DropboxKey | null>;
    lend: () => Promise<Connection>;
    run: (
      messages: QueuedRequest[],
      connection: Connection,
    ) => Promise<{ ack: number | null; applied?: number }>;
    valid: () => boolean;
    fetch?: typeof fetch;
  },
  signal: AbortSignal,
): Promise<PlaybackReceiptDrainOutcome> {
  return one(
    {
      id: loop.id,
      run: async (messages) => {
        if (signal.aborted || !loop.valid()) return { ack: null };
        const dropbox = await loop.key();
        if (!dropbox || signal.aborted || !loop.valid()) return { ack: null };
        const connection = await loop.lend();
        if (signal.aborted || !loop.valid()) return { ack: null };
        return loop.run(messages, connection);
      },
      valid: () => !signal.aborted && loop.valid(),
      ...(loop.fetch ? { fetch: loop.fetch } : {}),
    },
    signal,
  );
}

/** Map one authority-fenced drain into the only presentation transition its caller needs to retain. */
export async function recover<Connection, Status>(
  work: {
    libraryId: string;
    model: {
      ensurePlaybackReceipts: () => Promise<DropboxKey | null>;
      applyPlaybackReceipts: (
        messages: QueuedRequest[],
        connection: Connection,
      ) => Promise<{ ack: number | null; applied?: number }>;
    };
    household: { ensurePlaybackReceipts: () => Promise<DropboxKey | null> } | null;
    lend: () => Promise<Connection>;
    fetchImpl?: typeof fetch;
  },
  valid: () => boolean,
  signal: AbortSignal,
  recovering: boolean,
  publish: (state: 'failed' | 'recovered' | null, expected?: Status) => Status | null,
): Promise<void> {
  try {
    const result = await current(
      {
        id: work.libraryId,
        key: () => (work.household ?? work.model).ensurePlaybackReceipts(),
        lend: work.lend,
        run: (messages, connection) => work.model.applyPlaybackReceipts(messages, connection),
        valid,
        ...(work.fetchImpl ? { fetch: work.fetchImpl } : {}),
      },
      signal,
    );
    if (result.outcome === 'retired') return;
    if (result.outcome === 'failed') publish('failed');
    else if (!recovering) publish(null);
    else {
      const recovered = publish('recovered');
      if (recovered) setTimeout(() => publish(null, recovered), 5_000);
    }
  } catch (error) {
    if (!signal.aborted) {
      console.warn('asst/receipts', error);
      publish('failed');
    }
  }
}

/** How often the publisher asks the library service whether a projection is due (§15: it debounces and heartbeats). */
const PUBLISH_TICK_MS = 30_000;

/**
 * §15 *Publishing*: while the library is open, ask the library service every 30 s to send each read grant's
 * projection that is due. One tab of this browser publishes a library at a time (a Web Lock), another taking over
 * when it closes; another device publishing too only replaces it with the same lists.
 */
export function publish(
  loop: {
    id: string;
    run: (signal: AbortSignal) => Promise<unknown>;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
  signal: AbortSignal,
): Promise<void> {
  const sleep = loop.wait ?? pause;
  return exclusive(`den.assistant.publish.${loop.id}`, async () => {
    while (!signal.aborted) {
      try {
        await loop.run(signal);
      } catch (error) {
        if (!signal.aborted) console.warn('asst/publish', error);
      }
      if (!signal.aborted) await sleep(PUBLISH_TICK_MS, signal);
    }
  });
}

export interface DrainLoop {
  id: string;
  /** Drain this queue instead of the library's: a TV's lane (§16). */
  queue?: OtherQueue;
  /** Opens, checks and applies a drain's requests in the library service. */
  run: (messages: QueuedRequest[], signal: AbortSignal) => Promise<ApplyOutcome>;
  /** Told of each applied request, for the page's quiet toast. */
  done: (result: Extract<ApplyResult, { outcome: 'accepted' }>) => void;
  fetch?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Drain the library's assistant queue while `signal` stands: at once, then held (`?wait=`). One tab of this browser
 * drains a library at a time (a Web Lock); another takes over when it closes. Another device draining at once is
 * safe — the applied row refuses a request applied already — so the lock only saves the work twice.
 */
export function drain(loop: DrainLoop, signal: AbortSignal): Promise<void> {
  return exclusive(`den.assistant.drain.${loop.id}${loop.queue?.key ?? ''}`, () =>
    drainLoop(loop, signal),
  );
}

async function drainLoop(loop: DrainLoop, signal: AbortSignal): Promise<void> {
  const sleep = loop.wait ?? pause;
  const fetchImpl = loop.fetch ?? relayFetch;
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
      outcome = await loop.run(messages, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    } catch (error) {
      if (signal.aborted) return;
      console.warn('asst/apply', error);
      await sleep(BACKOFF_MS, signal);
      continue;
    }
    // The service may have completed as this authority retired. Its durable receipt makes redelivery safe; this
    // obsolete page must not announce an effect, publish a drop-box key or acknowledge the queue.
    if (signal.aborted) return;
    // The library queue's drain gives den-edge the drop-box key; a lane's leaves that to it.
    if (
      !loop.queue &&
      outcome.dropbox &&
      outcome.dropbox.public !== put &&
      (await putDropbox(outcome.dropbox, signal, fetchImpl))
    )
      put = outcome.dropbox.public;
    if (signal.aborted) return;
    for (const result of outcome.results) {
      if (result.outcome === 'accepted') loop.done(result);
      // The reason, never the request: it is the household's, and a refusal is no error of this page's.
      else console.info('asst/refused', result.reason);
    }
    if (outcome.ack !== null)
      await ackQueue(outcome.ack, fetchImpl, loop.queue, 'assistant', signal);
    if (signal.aborted) return;
    // An empty answer may come early (den-edge was busy, or the hold was refused), and requests left unacknowledged
    // come straight back: never drain again at once.
    const last = messages.at(-1)?.seq;
    const left = last !== undefined && (outcome.ack === null || outcome.ack < last);
    if (left || (!messages.length && Date.now() - started < 1_000)) await sleep(IDLE_MS, signal);
    wait = WAIT_S;
  }
}
