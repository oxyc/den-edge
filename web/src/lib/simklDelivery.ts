import { fetchSimklClientId } from '../settings/simkl';
import type { LibraryLog } from './log';
import { syncPolicy } from './syncCore';
import { rowName, type ReceiptRow, type Row, type SettingsRow, type Stamp } from './wire';

const pageStartedAt = Date.now();
const pageStartedMono = globalThis.performance?.now() ?? 0;
const TEN_MINUTES = 10 * 60_000;
const heldLeases = new WeakMap<LibraryLog, { account: string; epoch: number; at: number }>();

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

/** One bounded Library v3 delivery pass. False means observation, lease or provider facts were not ready. */
export async function deliverSimkl(
  log: LibraryLog,
  device: string,
  fetchImpl: typeof fetch = fetch,
  observedFor = Math.max(
    Date.now() - pageStartedAt,
    (globalThis.performance?.now() ?? 0) - pageStartedMono,
  ),
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
  const account = connection[0].slice('simkl:'.length);
  let token: string;
  try {
    token = (
      JSON.parse((connection[1].value as { string: string }).string) as { access_token: string }
    ).access_token;
  } catch {
    return false;
  }
  const deliver = log.settings(`deliver:simkl:${account}`);
  const leaseValue = deliver?.values.lease?.value;
  const lease = leaseValue && 'strings' in leaseValue ? leaseValue.strings : ['', '0'];
  if (lease[0] !== device && observedFor < TEN_MINUTES) return false;
  const held = heldLeases.get(log);
  const locallyHeld =
    lease[0] === device && held?.account === account && Date.now() - held.at < 120_000;
  const epoch = locallyHeld
    ? held.epoch
    : lease[0] === device
      ? Number(lease[1] ?? 0)
      : Number(lease[1] ?? 0) + 1;
  const at = syncPolicy<Stamp>({ op: 'issue', last: log.newestStamp(), now: Date.now(), device });
  const base: SettingsRow = deliver ?? {
    kind: 'set',
    schema: 2,
    name: `deliver:simkl:${account}`,
    values: {},
  };
  if (!locallyHeld || Date.now() - held!.at >= 60_000) {
    if (
      !(await log.write(
        {
          ...base,
          values: { ...base.values, lease: { value: { strings: [device, String(epoch)] }, at } },
        },
        undefined,
        false,
      ))
    )
      return false;
    heldLeases.set(log, { account, epoch, at: Date.now() });
  }

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
  const rows = log.rows();
  const allTargets = targets(rows, Date.now());
  const sinceText = base.values.since?.value;
  const since = sinceText && 'string' in sinceText ? (JSON.parse(sinceText.string) as Stamp) : at;
  const pending = syncPolicy<Record<string, unknown>[]>({
    op: 'pending_targets',
    targets: allTargets,
    receipts: receipts(rows, 'simkl', account),
    since,
    now: Date.now(),
  });
  let order = 0;
  for (const command of pending.slice(0, 100)) {
    const target = command.built_from as Target;
    const id = identity(target.media, target.id, target.season, target.episode_number);
    const title = identity(target.media, target.id);
    const rating = snapshot.ratings.get(title);
    const remote = {
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
    const outcome = syncPolicy<{ action: string }>({ op: 'decide', command, remote });
    if (outcome.action === 'hold' || outcome.action === 'superseded') continue;
    if (outcome.action === 'send' && !(await send(command, target, clientId, token, fetchImpl)))
      continue;
    const settled = syncPolicy<unknown>({
      op: 'settle',
      outcome,
      built_from: target,
      order: [epoch, ++order, device],
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
