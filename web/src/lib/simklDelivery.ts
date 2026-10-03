import { fetchSimklClientId } from '../settings/simkl';
import { exclusive, type LibraryLog } from './log';
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
const heldLeases = new WeakMap<LibraryLog, { account: string; epoch: number; at: number }>();

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
  listed: Set<string>;
  ratings: Map<string, number>;
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
  const snapshot: Snapshot = { watched: new Set(), listed: new Set(), ratings: new Map() };
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  for (const item of Array.isArray(root.movies) ? root.movies : []) {
    const movie = item as {
      movie?: { ids?: { tmdb?: number } };
      watched_at?: unknown;
      status?: string;
      user_rating?: number;
    };
    const id = movie.movie?.ids?.tmdb;
    if (!id) continue;
    const key = identity('movie', id);
    if (movie.watched_at) snapshot.watched.add(key);
    if (movie.status === 'plantowatch') snapshot.listed.add(key);
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
      seasons?: { number?: number; episodes?: { number?: number; watched_at?: unknown }[] }[];
    };
    const id = show.show?.ids?.tmdb;
    if (!id) continue;
    const title = identity('tv', id);
    if (show.status === 'plantowatch') snapshot.listed.add(title);
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
    listed: snapshot.listed.has(title) ? { at: null } : null,
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

const ordersHere = new Map<string, number>();

/**
 * Settle orders that never repeat within an epoch (v3 §6): the last one this device used is kept in this browser,
 * which every tab of it shares, and a pass takes its orders under one lock per account (`deliverSimkl`). Starting
 * at 0 on every pass reused `[E, 1, device]` across passes and tabs, and a merge of two equal orders falls back to
 * byte order, which could bring back an older receipt.
 */
function orderCounter(account: string, epoch: number): () => number {
  const key = `den.simklOrder.${account}.${epoch}`;
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
    if (
      outcome.action === 'send' &&
      !(await send(command, target, pass.clientId, pass.token, pass.fetchImpl))
    )
      continue;
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
    deliverAccount(log, device, fetchImpl, elapsed, account, token),
  );
}

/** A `set:deliver` setting holding JSON in a string (`since`, `removals`), parsed; undefined when absent. */
function jsonSetting(row: SettingsRow, name: string): unknown {
  const value = row.values[name]?.value;
  return value && 'string' in value ? JSON.parse(value.string) : undefined;
}

async function deliverAccount(
  log: LibraryLog,
  device: string,
  fetchImpl: typeof fetch,
  elapsed: number,
  account: string,
  token: string,
): Promise<boolean> {
  const name = `deliver:simkl:${account}`;
  const deliver = log.settings(name);
  const base: SettingsRow = deliver ?? { kind: 'set', schema: 2, name, values: {} };
  const leaseValue = deliver?.values.lease?.value;
  const lease = leaseValue && 'strings' in leaseValue ? leaseValue.strings : ['', '0'];
  // v3 §6 *Taking*, which v4 §11 keeps: a generation this browser has not yet watched for ten minutes — a new page
  // that kept none, or one that changed under it — is watched that long before any take, and the take is fresh even
  // where the row names this device. Another device's lease is taken only once its row has stayed unchanged that long.
  const observed = observe(log, account, log.seqOf(rowName(base)), elapsed);
  const fresh = log.observedGeneration !== log.currentGeneration;
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
  const at = syncPolicy<Stamp>({ op: 'issue', last: log.newestStamp(), now: Date.now(), device });
  const since = (jsonSetting(base, 'since') as Stamp | undefined) ?? at;
  // On v4 the pass is decided before the take, which needs the greatest settle epoch any receipt holds.
  const held = log.wireMinimum >= 4 ? log.documents() : [];
  const unverified = base.values.unverified?.value;
  const pendingV4 =
    log.wireMinimum >= 4
      ? syncPolicy<V4Pending>({
          op: 'pending_targets_v4',
          documents: held.map(({ document }) => document),
          deliver: {
            provider: 'simkl',
            account,
            since,
            // The removals latch and its approval, and the epochs whose receipts are unverified (v3 §6).
            removals: jsonSetting(base, 'removals') ?? null,
            unverified: unverified && 'ints' in unverified ? unverified.ints : [],
          },
          now: Date.now(),
        })
      : null;
  const kept = heldLeases.get(log);
  const locallyHeld =
    lease[0] === device && kept?.account === account && Date.now() - kept.at < 120_000;
  const epoch = locallyHeld
    ? kept.epoch
    : lease[0] === device && !fresh
      ? Number(lease[1] ?? 0)
      : Math.max(Number(lease[1] ?? 0), pendingV4?.greatest_epoch ?? 0) + 1;
  if (!locallyHeld || Date.now() - kept!.at >= 60_000) {
    // Compare-and-set on the lease as read: another device that took or renewed it since wins, and this pass stops.
    const leased: SettingsRow = {
      ...base,
      values: { ...base.values, lease: { value: { strings: [device, String(epoch)] }, at } },
    };
    if (!(await log.writeAt(leased, log.seqOf(rowName(leased))))) return false;
    heldLeases.set(log, { account, epoch, at: Date.now() });
    if (fresh) log.observedGeneration = log.currentGeneration;
  }
  const order = orderCounter(account, epoch);

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
