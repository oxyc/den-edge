import { fetchSimklClientId } from '../settings/simkl';
import type { ClockStore } from './clockStore';
import { exclusive } from './exclusive';
import type { LibraryLog } from './log';
import { syncPolicy } from './syncCore';
import {
  rowName,
  type DocumentRow,
  type ReceiptRow,
  type Row,
  type SettingsRow,
  type Stamp,
} from './wire';

const pageStartedAt = Date.now();
const pageStartedMono = globalThis.performance?.now() ?? 0;
const TEN_MINUTES = 10 * 60_000;
const HOLD = 120_000;
/** This page's own take or renewal: when it was sent, on both clocks (v3 §6 *Holding*). */
const heldLeases = new WeakMap<
  LibraryLog,
  { account: string; epoch: number; at: number; mono: number }
>();

const monoNow = () => globalThis.performance?.now() ?? 0;

/**
 * Whether this page still holds the account's lease (v3 §6 *Holding*): its take or renewal was sent less than two
 * minutes ago on the greater of the elapsed `Date.now` and `performance.now`, and `Date.now` has not gone backwards.
 * Checked immediately before every tracker request.
 */
function holding(log: LibraryLog, account: string): boolean {
  const held = heldLeases.get(log);
  if (held?.account !== account) return false;
  const wall = Date.now() - held.at;
  if (wall < 0) return false;
  return Math.max(wall, monoNow() - held.mono) < HOLD;
}

/**
 * What this page has watched of a library (v3 §6 *Taking*): the generation it reads, since when, and each account's
 * lease row at the seq it was first seen at, since when. Times are `pageElapsed` readings.
 */
const watching = new WeakMap<
  LibraryLog,
  {
    generation: string | undefined;
    since: number;
    leases: Map<string, { seq: number; since: number }>;
  }
>();

/** Milliseconds since this page started, on the lesser of its clocks (v3 §6 *Taking*). */
function pageElapsed(): number {
  return Math.min(
    Date.now() - pageStartedAt,
    (globalThis.performance?.now() ?? 0) - pageStartedMono,
  );
}

/**
 * How long this page has watched the library's current generation, and the account's lease row unchanged at `seq`.
 * A new generation starts both over, and forgets a lease held under the old one.
 */
function observe(log: LibraryLog, account: string, seq: number, elapsed: number) {
  let watch = watching.get(log);
  if (!watch || watch.generation !== log.currentGeneration) {
    watch = { generation: log.currentGeneration, since: elapsed, leases: new Map() };
    watching.set(log, watch);
    heldLeases.delete(log);
  }
  let lease = watch.leases.get(account);
  if (lease?.seq !== seq) {
    lease = { seq, since: elapsed };
    watch.leases.set(account, lease);
  }
  return { generation: elapsed - watch.since, lease: elapsed - lease.since };
}

interface Target extends Record<string, unknown> {
  key: string;
  receipt_target: string;
  receipt_key: string;
  kind: 'episode' | 'film' | 'list' | 'rating';
  value: string;
  stamp: Stamp;
  media: 'movie' | 'tv';
  id: number;
  season?: number;
  episode_number?: number;
}

interface Snapshot {
  watched: Set<string>;
  /** Each listed title, with when SIMKL says it was added (ms), or null where it doesn't say. */
  listed: Map<string, number | null>;
  ratings: Map<string, number>;
}

/** SIMKL's `added_to_watchlist_at`, in ms; null when absent or unreadable. */
function addedAt(value: unknown): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

const identity = (media: string, id: number, season?: number, episode?: number) =>
  season === undefined ? `${media}:${id}` : `${media}:${id}:${season}:${episode}`;

function targets(rows: Row[], now: number): Target[] {
  const out: Target[] = [];
  for (const row of rows) {
    if (row.kind === 'rec') {
      const target = rowName(row);
      const common = { media: row.title.type, id: row.title.id } as const;
      if (row.title.type === 'movie') {
        out.push({
          ...common,
          key: `${target}#watch`,
          receipt_target: target,
          receipt_key: 'watch',
          kind: 'film',
          value: row.status.value === 'watched' ? 'watched' : 'unwatched',
          stamp: row.status.at,
          p: row.resume.viewing,
          watched_at: row.watchedAt,
        });
      }
      out.push({
        ...common,
        key: `${target}#list`,
        receipt_target: target,
        receipt_key: 'list',
        kind: 'list',
        value: row.status.value === 'watchlist' ? 'in' : 'gone',
        stamp: row.status.at,
      });
      out.push({
        ...common,
        key: `${target}#rating`,
        receipt_target: target,
        receipt_key: 'rating',
        kind: 'rating',
        value: row.reaction.value ?? 'none',
        stamp: row.reaction.at,
      });
    } else if (row.kind === 'wat' && row.title.type === 'tv') {
      for (const [episode, register] of Object.entries(row.entries)) {
        const state = syncPolicy<{ watched: boolean; viewing: number; watched_at: number | null }>({
          op: 'episode_state',
          register,
          resets: [row.seasonReset].filter(Boolean),
          now,
        });
        const stamp = register.progress?.at ?? ([0, 0, ''] as Stamp);
        out.push({
          key: `${rowName(row)}#${episode}`,
          receipt_target: rowName(row),
          receipt_key: episode,
          kind: 'episode',
          value: state.watched ? 'watched' : 'unwatched',
          stamp,
          p: state.viewing,
          watched_at: state.watched_at,
          media: 'tv',
          id: row.title.id,
          season: row.season,
          episode_number: Number(episode),
        });
      }
    }
  }
  return out;
}

function receipts(rows: Row[], provider: string, account: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.kind !== 'snt' || row.provider !== provider || row.account !== account) continue;
    for (const [key, value] of Object.entries(row.entries)) out[`${row.target}#${key}`] = value;
  }
  return out;
}

function collectSnapshot(body: unknown): Snapshot {
  const snapshot: Snapshot = { watched: new Set(), listed: new Map(), ratings: new Map() };
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  for (const item of Array.isArray(root.movies) ? root.movies : []) {
    const movie = item as {
      movie?: { ids?: { tmdb?: number } };
      watched_at?: unknown;
      status?: string;
      user_rating?: number;
      added_to_watchlist_at?: unknown;
    };
    const id = movie.movie?.ids?.tmdb;
    if (!id) continue;
    const key = identity('movie', id);
    if (movie.watched_at) snapshot.watched.add(key);
    if (movie.status === 'plantowatch')
      snapshot.listed.set(key, addedAt(movie.added_to_watchlist_at));
    if (typeof movie.user_rating === 'number') snapshot.ratings.set(key, movie.user_rating);
  }
  for (const item of [
    ...(Array.isArray(root.shows) ? root.shows : []),
    ...(Array.isArray(root.anime) ? root.anime : []),
  ]) {
    const show = item as {
      show?: { ids?: { tmdb?: number } };
      status?: string;
      user_rating?: number;
      added_to_watchlist_at?: unknown;
      seasons?: { number?: number; episodes?: { number?: number; watched_at?: unknown }[] }[];
    };
    const id = show.show?.ids?.tmdb;
    if (!id) continue;
    const title = identity('tv', id);
    if (show.status === 'plantowatch')
      snapshot.listed.set(title, addedAt(show.added_to_watchlist_at));
    if (typeof show.user_rating === 'number') snapshot.ratings.set(title, show.user_rating);
    for (const season of show.seasons ?? [])
      for (const episode of season.episodes ?? []) {
        if (season.number !== undefined && episode.number !== undefined && episode.watched_at)
          snapshot.watched.add(identity('tv', id, season.number, episode.number));
      }
  }
  return snapshot;
}

async function simkl(
  path: string,
  clientId: string,
  token: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  return fetchImpl(`https://api.simkl.com${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'simkl-api-key': clientId,
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
}

async function send(
  command: Record<string, unknown>,
  target: Target,
  clientId: string,
  token: string,
  fetchImpl: typeof fetch,
) {
  const ids = { tmdb: target.id };
  const episode =
    target.media === 'tv' && target.season !== undefined
      ? {
          shows: [
            {
              ids,
              seasons: [{ number: target.season, episodes: [{ number: target.episode_number }] }],
            },
          ],
        }
      : { movies: [{ ids }] };
  let path = '/sync/history';
  let body: unknown = episode;
  if (command.kind === 'unwatched') path = '/sync/history/remove';
  if (command.kind === 'list') {
    path = command.added ? '/sync/add-to-list' : '/sync/history/remove';
    body = command.added
      ? {
          [target.media === 'movie' ? 'movies' : 'shows']: [{ ids, to: 'plantowatch' }],
        }
      : episode;
  }
  if (command.kind === 'rating') {
    path = command.rating == null ? '/sync/ratings/remove' : '/sync/ratings';
    body = {
      [target.media === 'movie' ? 'movies' : 'shows']: [
        { ids, ...(command.rating == null ? {} : { rating: command.rating }) },
      ],
    };
  }
  return (
    await simkl(path, clientId, token, fetchImpl, { method: 'POST', body: JSON.stringify(body) })
  ).ok;
}

/** What SIMKL holds for a target, as den-core's `decide` asks it. */
function remoteFacts(snapshot: Snapshot, id: string, title: string) {
  const rating = snapshot.ratings.get(title);
  return {
    authoritative: true,
    account_matches: true,
    simkl: true,
    watched: snapshot.watched.has(id) ? { at: null } : null,
    listed: snapshot.listed.has(title) ? { at: snapshot.listed.get(title) ?? null } : null,
    rated: rating === undefined ? null : { at: null, value: rating },
    any_title_watch: snapshot.watched.has(title),
    unknown_or_newer_title_watch: false,
    episodes_complete: true,
    plays: [],
    unwatch_then_remark: false,
  };
}

/** A command or a silent settle of `pending_targets_v4`: which delivery document and key it is for. */
interface V4Target {
  document: string;
  key: string;
  built_from: Record<string, unknown>;
}

/** `pending_targets_v4`'s answer, read before the lease is taken so the take's epoch can pass every settle epoch. */
interface V4Pending {
  commands: (V4Target & Record<string, unknown>)[];
  settle: V4Target[];
  greatest_epoch: number;
  /** `{held}` when the removals latch closes in this pass (v4 §9). */
  removals?: { held: Stamp } | null;
  /** The stamp an approval of the removals held now writes (v4 §9). */
  approval?: Stamp | null;
  /** The account's unverified epochs after this read. */
  unverified?: number[];
}

interface V4Pass {
  token: string;
  clientId: string;
  snapshot: Snapshot;
  pending: V4Pending;
  stored: Map<string, { seq: number; document: DocumentRow }>;
  account: string;
  epoch: number;
  device: string;
  /** The next settle order in this epoch (`orderCounter`). */
  order: () => number;
  fetchImpl: typeof fetch;
}

/** This page's own order counters, per library: what it used where storage is blocked. */
const ordersHere = new WeakMap<LibraryLog, Map<string, number>>();

function ordersOf(log: LibraryLog): Map<string, number> {
  let orders = ordersHere.get(log);
  if (!orders) ordersHere.set(log, (orders = new Map()));
  return orders;
}

/**
 * Settle orders that never repeat within an epoch (v3 §6): the last one this device used is kept in this browser,
 * which every tab of it shares, and a pass takes its orders under one lock per account (`deliverSimkl`). Starting
 * at 0 on every pass reused `[E, 1, device]` across passes and tabs, and a merge of two equal orders falls back to
 * byte order, which could bring back an older receipt.
 */
function orderCounter(log: LibraryLog, account: string, epoch: number): () => number {
  const key = `den.simklOrder.${account}.${epoch}`;
  const ordersHere = ordersOf(log);
  let last = ordersHere.get(key) ?? 0;
  try {
    last = Math.max(last, Number(globalThis.localStorage?.getItem(key)) || 0);
  } catch {
    // Storage blocked: this page's own count still never repeats.
  }
  return () => {
    last++;
    ordersHere.set(key, last);
    try {
      globalThis.localStorage?.setItem(key, String(last));
    } catch {
      // As above.
    }
    return last;
  };
}

/**
 * The greatest epoch this browser has settled under for an account: every epoch it used keeps an order counter
 * (`orderCounter`), so a take never reuses one, even after a restore rolls the row and the receipts back (v3 §6).
 */
function heldEpoch(log: LibraryLog, account: string): number {
  const prefix = `den.simklOrder.${account}.`;
  let greatest = 0;
  const consider = (key: string | null) => {
    if (key?.startsWith(prefix))
      greatest = Math.max(greatest, Number(key.slice(prefix.length)) || 0);
  };
  for (const key of ordersOf(log).keys()) consider(key);
  try {
    const storage = globalThis.localStorage;
    for (let i = 0; i < (storage?.length ?? 0); i++) consider(storage!.key(i));
  } catch {
    // Storage blocked: this page's own epochs still count.
  }
  return greatest;
}

/** When this page sent list removals, per library and account, on both clocks. */
const removalsSentHere = new WeakMap<LibraryLog, Map<string, { at: number; mono: number }[]>>();

/**
 * The list removals sent for an account in the last 120 s, as den-core takes them (`removals_sent`, v4 §9). Kept in
 * this browser's storage, which every tab and every reload shares, so a second tab or a reload sees the same window.
 * This page's own sends also carry `performance.now`, so a `Date` step forward doesn't drop them from the count, and
 * a send after `now` (`Date` stepped back) still counts, passed as `now`: den-core counts none later than `now`.
 */
function recentRemovals(log: LibraryLog, account: string, sentNow = false): number[] {
  const now = Date.now();
  const mono = monoNow();
  const byWall = (at: number) => now - at < 120_000;
  let here = removalsSentHere.get(log);
  if (!here) removalsSentHere.set(log, (here = new Map()));
  const mine = (here.get(account) ?? []).filter((s) => byWall(s.at) || mono - s.mono < 120_000);
  if (sentNow) mine.push({ at: now, mono });
  here.set(account, mine);
  let stored: number[] | null = null;
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      const key = `den.simklRemovalsSent.${account}`;
      const kept: unknown = JSON.parse(storage.getItem(key) ?? '[]');
      stored = (Array.isArray(kept) ? kept : []).filter(
        (at): at is number => typeof at === 'number' && byWall(at),
      );
      if (sentNow) stored.push(now);
      storage.setItem(key, JSON.stringify(stored));
    }
  } catch (error) {
    console.warn(`den: the SIMKL removals sent can't be kept in this browser: ${error}`);
    stored = null;
  }
  // Storage holds every tab's sends that `Date` counts; this page adds its own that only `performance.now` still does.
  const recent =
    stored === null
      ? mine.map((s) => s.at)
      : [...stored, ...mine.filter((s) => !byWall(s.at)).map((s) => s.at)];
  return recent.map((at) => Math.min(at, now));
}

/**
 * The account's removals latch (v4 §9), parsed. A value that isn't JSON goes to den-core as the bare string, which it
 * reads as a closed latch with no approval: the safety latch fails closed.
 */
function latchSetting(row: SettingsRow): unknown {
  const value = row.values.removals?.value;
  if (!value || !('string' in value)) return undefined;
  try {
    return JSON.parse(value.string);
  } catch (error) {
    console.warn(`den: ${row.name}'s removals latch is malformed; read as closed: ${error}`);
    return value.string;
  }
}

/** A stamp's order (v2 §4): time, then counter, then device. */
function stampOrder(a: Stamp, b: Stamp): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

/** The removals latch as its setting stores it: JSON with sorted keys, as den-core's merge writes it. */
function latchText(latch: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(latch).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}

/** The account's `set:deliver` facts `pending_targets_v4` reads (v4 §9). */
function deliverFacts(log: LibraryLog, row: SettingsRow, account: string, since: Stamp) {
  const unverified = row.values.unverified?.value;
  return {
    provider: 'simkl',
    account,
    since,
    removals: latchSetting(row) ?? null,
    unverified: unverified && 'ints' in unverified ? unverified.ints : [],
    removals_sent: recentRemovals(log, account),
  };
}

/** The title (and season) a delivery document's name spells: `dlv:simkl:<account>:<type>:<id>[:<season>]`. */
function deliveryTitle(name: string): { media: 'movie' | 'tv'; id: number; season?: number } {
  const [, , , media, id, season] = name.split(':');
  return {
    media: media === 'tv' ? 'tv' : 'movie',
    id: Number(id),
    ...(season === undefined ? {} : { season: Number(season) }),
  };
}

/**
 * One Library v4 delivery pass (§9) on the documents read to the head: den-core's `pending_targets_v4` decides
 * what to send and what settles silently. A command whose receipt would not fit its delivery document is held, not
 * sent. Each delivery document is then written once, compare-and-set on the seq it was read at; a conflict is
 * dropped, and its targets are decided again next pass.
 */
async function deliverV4(log: LibraryLog, pass: V4Pass): Promise<void> {
  const { account, epoch, device, snapshot, pending, stored, order } = pass;
  const entry = (name: string, key: string) =>
    (stored.get(name)?.document.entries as Record<string, unknown> | undefined)?.[key] ?? null;
  const settle = (outcome: Record<string, unknown>, target: V4Target, at: number) =>
    syncPolicy<unknown>({
      op: 'settle_v4',
      outcome,
      built_from: target.built_from,
      order: [epoch, at, device],
      entry: entry(target.document, target.key),
    });
  const writes = new Map<string, { key: string; settle: unknown }[]>();
  const add = (target: V4Target, settled: unknown) => {
    if (settled === null) return;
    const list = writes.get(target.document) ?? [];
    list.push({ key: target.key, settle: settled });
    writes.set(target.document, list);
  };
  const shape = (name: string) => {
    const document = stored.get(name)?.document;
    if (document) return { document };
    const { media, id, season } = deliveryTitle(name);
    return {
      identity: {
        provider: 'simkl',
        account,
        title: { type: media, id },
        ...(season === undefined ? {} : { season }),
      },
    };
  };
  for (const target of pending.settle)
    add(target, settle({ action: 'acknowledge' }, target, order()));

  // Fit before sending: each document as it would be with every settle this pass writes to it.
  const commands = pending.commands.slice(0, 100).map((command) => ({ command, at: order() }));
  const full = new Set<string>();
  for (const name of new Set(commands.map(({ command }) => command.document))) {
    const fit = syncPolicy<{ held: { key: string }[] }>({
      op: 'delivery_write',
      ...shape(name),
      commands: [
        ...(writes.get(name) ?? []),
        ...commands
          .filter(({ command }) => command.document === name)
          .map(({ command, at }) => ({
            key: command.key,
            settle: settle({ action: 'send' }, command, at),
          })),
      ],
    });
    for (const { key } of fit.held) full.add(`${name}#${key}`);
  }

  for (const { command, at } of commands) {
    if (full.has(`${command.document}#${command.key}`)) {
      console.warn(`den: ${command.document} is full; ${command.key} is held, not sent`);
      continue;
    }
    const { media, id, season } = deliveryTitle(command.document);
    const episode = command.episode === true ? Number(command.key) : undefined;
    const target = { media, id, season, episode_number: episode } as Target;
    const outcome = syncPolicy<{ action: string }>({
      op: 'decide',
      command,
      remote: remoteFacts(
        snapshot,
        identity(media, id, episode === undefined ? undefined : season, episode),
        identity(media, id),
      ),
    });
    if (outcome.action === 'hold' || outcome.action === 'superseded') continue;
    if (outcome.action === 'send' && !holding(log, account)) {
      console.warn('den: the SIMKL lease lapsed during a delivery pass; stopping it');
      break;
    }
    if (
      outcome.action === 'send' &&
      !(await send(command, target, pass.clientId, pass.token, pass.fetchImpl))
    )
      continue;
    if (outcome.action === 'send' && command.kind === 'list' && command.added === false)
      recentRemovals(log, account, true);
    add(command, settle(outcome, command, at));
  }

  for (const [name, settles] of writes) {
    const written = syncPolicy<{ document: DocumentRow }>({
      op: 'delivery_write',
      ...shape(name),
      commands: settles,
    });
    if (!(await log.writeAt(written.document, stored.get(name)?.seq ?? 0)))
      console.warn(
        `den: the receipts in ${name} were not written; they are decided again next pass`,
      );
  }
}

/**
 * One bounded delivery pass. False means observation, lease or provider facts were not ready. `elapsed` is this
 * page's age on the lesser of its clocks; the lease and generation observations are measured on it.
 */
export async function deliverSimkl(
  log: LibraryLog,
  device: string,
  fetchImpl: typeof fetch = fetch,
  elapsed = pageElapsed(),
): Promise<boolean> {
  const clock = legacyClock(log, device);
  return deliverSimklWithClock(log, clock, fetchImpl, elapsed);
}

/** Service-owned delivery. Every durable stamp comes from the worker-safe, cross-tab clock store. */
export async function deliverSimklWithClock(
  log: LibraryLog,
  clock: ClockStore,
  fetchImpl: typeof fetch = fetch,
  elapsed = pageElapsed(),
): Promise<boolean> {
  const tracker = log.settings('trackers');
  const connection = Object.entries(tracker?.values ?? {}).find(
    ([name, value]) =>
      name.startsWith('simkl:') &&
      !name.endsWith('.token') &&
      value.value &&
      'string' in value.value,
  );
  if (!connection) return false;
  // While a row can't be read, it may be a delivery document: nothing is delivered until it is removed (v4 §4).
  if (log.wireMinimum >= 4 && (log.unreadable.size || log.newerFraming.size)) return false;
  const account = connection[0].slice('simkl:'.length);
  let token: string;
  try {
    token = (
      JSON.parse((connection[1].value as { string: string }).string) as { access_token: string }
    ).access_token;
  } catch {
    return false;
  }
  // One pass at a time per account in this browser: its tabs share the device id, and so the lease and the orders.
  return exclusive(`den.simkl.${account}`, () =>
    deliverAccount(log, clock, fetchImpl, elapsed, account, token),
  );
}

/**
 * The lease holder keeps what den-core answered about the account on its `set:deliver` row (v4 §9 *Account
 * settings*): the removals latch closed at den-core's `held`, beside the stored approval, and the `unverified`
 * epochs when they changed, replacing the setting. By compare-and-set; one that loses is decided again next pass.
 */
async function writeAccountState(
  log: LibraryLog,
  name: string,
  pending: V4Pending,
  clock: ClockStore,
) {
  const row = log.settings(name);
  if (!row) return;
  const values = { ...row.values };
  await clock.see(log.newestStamp());
  let changed = false;
  const removals = latchSetting(row);
  const latch =
    removals && typeof removals === 'object' ? (removals as Record<string, unknown>) : {};
  const closing = pending.removals?.held;
  const stored = Array.isArray(latch.held) ? (latch.held as Stamp) : null;
  if (closing && (!stored || stampOrder(stored, closing) < 0)) {
    // Beside the stored approval, never over it: removals approved before this batch are still decided.
    values.removals = {
      value: { string: latchText({ ...latch, held: closing }) },
      at: await clock.issue(),
    };
    changed = true;
  }
  if (pending.unverified) {
    const listed = row.values.unverified?.value;
    const current = listed && 'ints' in listed ? listed.ints : [];
    const epochs = [...pending.unverified].sort((a, b) => a - b);
    if (JSON.stringify(epochs) !== JSON.stringify(current)) {
      values.unverified = { value: { ints: epochs }, at: await clock.issue() };
      changed = true;
    }
  }
  if (changed && !(await log.writeAt({ ...row, values }, log.seqOf(rowName(row)))))
    console.warn(
      `den: ${name}'s removals or unverified epochs lost a race; decided again next pass`,
    );
}

/** The SIMKL list removals the removals latch holds, and the stamp approving exactly them writes (v4 §9). */
export interface HeldRemovals {
  titles: { type: 'movie' | 'tv'; id: number }[];
  /** The latest value stamp among them: never a fresh one, so nothing made after the list was shown is approved. */
  approval: Stamp | null;
}

function simklAccountOf(log: LibraryLog): string | undefined {
  return Object.keys(log.settings('trackers')?.values ?? {})
    .find((key) => key.startsWith('simkl:') && !key.endsWith('.token'))
    ?.slice('simkl:'.length);
}

/** The SIMKL list removals the removals latch holds, by title: what a person sees, every one, before approving. */
export function heldSimklRemovals(log: LibraryLog): HeldRemovals {
  const none: HeldRemovals = { titles: [], approval: null };
  if (log.wireMinimum < 4) return none;
  const account = simklAccountOf(log);
  const row = account ? log.settings(`deliver:simkl:${account}`) : undefined;
  const since = row && (jsonSetting(row, 'since') as Stamp | undefined);
  if (!account || !row || !since) return none;
  const pending = syncPolicy<V4Pending>({
    op: 'pending_targets_v4',
    documents: log.documents().map(({ document }) => document),
    deliver: deliverFacts(log, row, account, since),
    now: Date.now(),
  });
  return {
    titles: pending.commands
      .filter((command) => command.removals_held === true && typeof command.title === 'string')
      .map((command) => {
        const [, type, id] = (command.title as string).split(':');
        return { type: type === 'tv' ? 'tv' : 'movie', id: Number(id) };
      }),
    approval: pending.approval ?? null,
  };
}

/**
 * A person approved the held removals they were shown (v4 §9): `approved` set to `shown.approval` beside the stored
 * `held`, on the account's `set:deliver` row by compare-and-set — never merged, which could lose it to a concurrent
 * hold. False when the row changed since it was read: the list is read again and shown again.
 */
export async function approveSimklRemovals(
  log: LibraryLog,
  device: string,
  shown: HeldRemovals,
): Promise<boolean> {
  return approveSimklRemovalsWithClock(log, legacyClock(log, device), shown);
}

export async function approveSimklRemovalsWithClock(
  log: LibraryLog,
  clock: ClockStore,
  shown: HeldRemovals,
): Promise<boolean> {
  const account = simklAccountOf(log);
  const row = account ? log.settings(`deliver:simkl:${account}`) : undefined;
  if (!row || !shown.approval) return false;
  const removals = latchSetting(row);
  const latch =
    removals && typeof removals === 'object' ? (removals as Record<string, unknown>) : {};
  await clock.see(log.newestStamp());
  const at = await clock.issue();
  const values = {
    ...row.values,
    removals: { value: { string: latchText({ ...latch, approved: shown.approval }) }, at },
  };
  return log.writeAt({ ...row, values }, log.seqOf(rowName(row)));
}

/** A `set:deliver` setting holding JSON in a string (`since`, `removals`), parsed; undefined when absent. */
function jsonSetting(row: SettingsRow, name: string): unknown {
  const value = row.values[name]?.value;
  return value && 'string' in value ? JSON.parse(value.string) : undefined;
}

async function deliverAccount(
  log: LibraryLog,
  clock: ClockStore,
  fetchImpl: typeof fetch,
  elapsed: number,
  account: string,
  token: string,
): Promise<boolean> {
  const device = clock.device;
  const name = `deliver:simkl:${account}`;
  const deliver = log.settings(name);
  const base: SettingsRow = deliver ?? { kind: 'set', schema: 2, name, values: {} };
  const leaseValue = deliver?.values.lease?.value;
  const lease = leaseValue && 'strings' in leaseValue ? leaseValue.strings : ['', '0'];
  // v3 §6 *Taking*, which v4 §11 keeps: a generation this browser has not yet watched for ten minutes — a new page
  // that kept none, or one that changed under it — is watched that long before any take, and the take is fresh even
  // where the row names this device. Another device's lease is taken only once its row has stayed unchanged that long.
  const observed = observe(log, account, log.seqOf(rowName(base)), elapsed);
  // An unknown generation (a commit whose answer named none) is never one this browser watched.
  const fresh =
    log.currentGeneration === undefined || log.observedGeneration !== log.currentGeneration;
  if (fresh && observed.generation < TEN_MINUTES) return false;
  if (lease[0] !== device) {
    const decision = syncPolicy<{ action: string }>({
      op: 'lease',
      input: {
        device,
        holder: lease[0],
        epoch: Number(lease[1] ?? 0),
        elapsed: 0,
        observed: observed.lease,
        fresh_generation: false,
      },
    });
    if (decision.action !== 'take') return false;
  }
  await clock.see(log.newestStamp());
  const at = await clock.issue();
  const since = (jsonSetting(base, 'since') as Stamp | undefined) ?? at;
  // On v4 the pass is decided before the take, which needs the greatest settle epoch any receipt holds.
  const held = log.wireMinimum >= 4 ? log.documents() : [];
  const pendingV4 =
    log.wireMinimum >= 4
      ? syncPolicy<V4Pending>({
          op: 'pending_targets_v4',
          documents: held.map(({ document }) => document),
          // The removals latch and its approval, the epochs whose receipts are unverified, and this page's recent
          // removal sends (v4 §9).
          deliver: deliverFacts(log, base, account, since),
          now: Date.now(),
        })
      : null;
  const kept = heldLeases.get(log);
  const locallyHeld = lease[0] === device && holding(log, account);
  // A take exceeds the row's epoch, every settle epoch read, and every epoch this browser held (v3 §6).
  const epoch =
    locallyHeld && kept
      ? kept.epoch
      : lease[0] === device && !fresh
        ? Number(lease[1] ?? 0)
        : Math.max(Number(lease[1] ?? 0), pendingV4?.greatest_epoch ?? 0, heldEpoch(log, account)) +
          1;
  if (!locallyHeld || !kept || Math.max(Date.now() - kept.at, monoNow() - kept.mono) >= HOLD / 2) {
    // Compare-and-set on the lease as read: another device that took or renewed it since wins, and this pass stops.
    // The hold counts from when the request was sent.
    const leased: SettingsRow = {
      ...base,
      values: { ...base.values, lease: { value: { strings: [device, String(epoch)] }, at } },
    };
    const sent = { at: Date.now(), mono: monoNow() };
    if (!(await log.writeAt(leased, log.seqOf(rowName(leased))))) return false;
    heldLeases.set(log, { account, epoch, ...sent });
    if (fresh) log.observedGeneration = log.currentGeneration;
  }
  if (pendingV4) await writeAccountState(log, name, pendingV4, clock);
  const order = orderCounter(log, account, epoch);

  const clientId = await fetchSimklClientId(fetchImpl);
  if (!clientId) return false;
  const snapshotResponse = await simkl(
    '/sync/all-items?extended=full&include_all_episodes=yes&episode_watched_at=yes',
    clientId,
    token,
    fetchImpl,
  );
  if (!snapshotResponse.ok) return false;
  const snapshot = collectSnapshot(await snapshotResponse.json());
  if (pendingV4) {
    const stored = new Map(held.map(({ seq, document }) => [rowName(document), { seq, document }]));
    await deliverV4(log, {
      token,
      clientId,
      snapshot,
      pending: pendingV4,
      stored,
      account,
      epoch,
      device,
      order,
      fetchImpl,
    });
    return true;
  }
  const rows = log.rows();
  const allTargets = targets(rows, Date.now());
  const pending = syncPolicy<Record<string, unknown>[]>({
    op: 'pending_targets',
    targets: allTargets,
    receipts: receipts(rows, 'simkl', account),
    since,
    now: Date.now(),
  });
  for (const command of pending.slice(0, 100)) {
    const target = command.built_from as Target;
    const id = identity(target.media, target.id, target.season, target.episode_number);
    const title = identity(target.media, target.id);
    const outcome = syncPolicy<{ action: string }>({
      op: 'decide',
      command,
      remote: remoteFacts(snapshot, id, title),
    });
    if (outcome.action === 'hold' || outcome.action === 'superseded') continue;
    if (outcome.action === 'send' && !holding(log, account)) break;
    if (outcome.action === 'send' && !(await send(command, target, clientId, token, fetchImpl)))
      continue;
    const settled = syncPolicy<unknown>({
      op: 'settle',
      outcome,
      built_from: target,
      order: [epoch, order(), device],
    });
    if (settled === null) continue;
    const name = syncPolicy<string>({
      op: 'receipt_name',
      provider: 'simkl',
      account,
      target: target.receipt_target,
    });
    const current = log
      .rows()
      .find((row): row is ReceiptRow => row.kind === 'snt' && rowName(row) === name);
    const receipt: ReceiptRow = current ?? {
      kind: 'snt',
      schema: 3,
      provider: 'simkl',
      account,
      target: target.receipt_target,
      entries: {},
    };
    await log.write(
      { ...receipt, entries: { ...receipt.entries, [target.receipt_key]: settled } },
      undefined,
      false,
    );
  }
  return true;
}

/** Compatibility for the page-owned session while the final atomic UI cutover is still in progress. */
function legacyClock(log: LibraryLog, device: string): ClockStore {
  let last = log.newestStamp();
  return {
    device,
    async issue(now = Date.now()) {
      last = syncPolicy<Stamp>({ op: 'issue', last, now, device });
      return last;
    },
    async see(stamp) {
      if (stampOrder(last, stamp) < 0) last = stamp;
    },
    async current() {
      return last;
    },
  };
}
