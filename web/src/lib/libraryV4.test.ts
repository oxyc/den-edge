import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToWatchlist,
  blankEpisode,
  blankTitle,
  markEpisode,
  markWatched,
  react,
} from './actions';
import { applyOps, opsFor } from './libraryV4';
import type { Vault } from './localVault';
import { LibraryLog, PRE_V4_BACKUP_ERROR } from './log';
import { approveSimklRemovals, deliverSimkl, heldSimklRemovals } from './simklDelivery';
import { recordTrackerEvent } from './trackerEvents';
import {
  deriveKeys,
  open,
  openEntry,
  seal,
  sealPlaintext,
  type DocumentRow,
  type LibraryKeys,
  type Row,
  type SettingsRow,
  type Stamp,
  type TitleRow,
} from './wire';

const LIBRARY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const libraryAlert = (log: LibraryLog): string | null => {
  if (log.upgradeRequired !== null) return 'Library update required';
  if (log.compactionRefused && log.unreadable.size)
    return 'Delivery paused: library rows can’t be read';
  return log.readOnlyReason;
};

const DEVICE = 'aaaaaaaaaaaaaaaa';
const at = (t: number): Stamp => [t, 0, DEVICE];

const rec = (type: 'movie' | 'tv', id: number, overrides: Partial<TitleRow> = {}): TitleRow => ({
  ...blankTitle({ type, id }, 1000),
  status: { value: 'watchlist', at: at(1000) },
  ...overrides,
});

const prefs: SettingsRow = {
  kind: 'set',
  schema: 2,
  name: 'prefs',
  values: { 'den.hideAnime': { value: { bool: true }, at: at(500) } },
};

function filmDocument(id: number, fields: Record<string, unknown> = {}): DocumentRow {
  return {
    format: 4,
    kind: 'title',
    title: { type: 'movie', id },
    status: { value: 'watchlist', at: at(1000) },
    addedAt: 1000,
    ...fields,
  };
}

/**
 * den-edge's `/lib` in memory, as far as a v4 client asks it: `changes`, compare-and-set `batch`, the fenced
 * `rewrite` (open, stage, commit, abort), the wire minimum and generation on every answer, and `/version`.
 */
async function edge(
  rows: Row[] = [],
  { wireMin = 4, version = '0.242.1' }: { wireMin?: number; version?: string } = {},
) {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  let head = 0;
  let generation = 'g1';
  const stored = new Map<string, { k: string; seq: number; v: string }>();
  for (const entry of await Promise.all(rows.map((row) => seal(keys, row))))
    stored.set(entry.k, { ...entry, seq: ++head });
  let fence: { base: number; staged: { k: string; v: string }[] } | null = null;
  const log = { commits: [] as unknown[], aborted: 0, refuseNext: null as string | null };
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'x-den-wire-min': String(wireMin), 'x-den-generation': generation },
    });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'https://den.example');
    if (url.pathname === '/version') return new Response(JSON.stringify({ version }));
    const action = url.pathname.split('/').slice(3).join('/');
    const method = init.method ?? 'GET';
    // A write from an older generation is refused before anything else looks at it, as library.rs does.
    const sent = new Headers(init.headers);
    if (method !== 'GET' && sent.has('x-den-wire') && sent.get('x-den-generation') !== generation)
      return reply({ error: 'generation_changed' }, 409);
    if (action === 'rewrite' && method === 'POST') {
      fence = { base: head, staged: [] };
      return reply({ rewrite: 'stage', base: head });
    }
    if (action === 'rewrite/stage/rows' && method === 'POST') {
      const { writes } = JSON.parse(String(init.body)) as { writes: { k: string; v: string }[] };
      fence!.staged.push(...writes);
      return reply({});
    }
    if (action === 'rewrite/stage/commit' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { base: number; wireMin: number };
      log.commits.push(body);
      stored.clear();
      head = 0;
      for (const write of fence!.staged) stored.set(write.k, { ...write, seq: ++head });
      wireMin = Math.max(wireMin, body.wireMin);
      generation = `g${log.commits.length + 1}`;
      fence = null;
      return reply({});
    }
    if (action === 'rewrite/stage' && method === 'DELETE') {
      log.aborted++;
      fence = null;
      return reply({});
    }
    if (action === 'batch' && method === 'POST') {
      if (fence) return reply({ error: 'rewrite_in_progress' }, 409);
      if (log.refuseNext) {
        const error = log.refuseNext;
        log.refuseNext = null;
        return reply({ error }, 409);
      }
      const { writes } = JSON.parse(String(init.body)) as {
        writes: { k: string; base: number; v: string }[];
      };
      const applied: { k: string; seq: number }[] = [];
      const conflicts: { k: string; seq: number; v: string | null }[] = [];
      for (const write of writes) {
        const current = stored.get(write.k);
        if ((current?.seq ?? 0) !== write.base) {
          conflicts.push({ k: write.k, seq: current?.seq ?? 0, v: current?.v ?? null });
          continue;
        }
        stored.set(write.k, { k: write.k, seq: ++head, v: write.v });
        applied.push({ k: write.k, seq: head });
      }
      return reply({ head, applied, conflicts });
    }
    if (action === 'member') return reply({});
    if (action.startsWith('changes')) {
      const since = Number(url.searchParams.get('since'));
      const newer = [...stored.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
      return reply({ generation, entries: newer.slice(0, 2), head, more: newer.length > 2 });
    }
    return reply({ error: 'not_found' }, 404);
  };
  /** Another device's write, landing as den-edge would apply it. */
  const append = async (row: Row) => {
    const entry = await seal(keys, row);
    stored.set(entry.k, { ...entry, seq: ++head });
  };
  /** A value stored as it is, whatever it holds. */
  const put = (entry: { k: string; v: string }) => stored.set(entry.k, { ...entry, seq: ++head });
  /** What den-edge holds, opened. */
  const opened = () => Promise.all([...stored.values()].map(({ k, v }) => open(keys, k, v)));
  /** A restore: the same rows under a new generation. */
  const restore = () => void (generation = `${generation}-restored`);
  return { keys, fetchImpl, stored, append, put, opened, restore, log, wireMin: () => wireMin };
}

const document = (rows: Row[], name: string) =>
  rows.find(
    (row): row is DocumentRow =>
      (row.kind === 'title' && name === `title:${row.title.type}:${row.title.id}`) ||
      (row.kind === 'season' && name === `season:tv:${row.title.id}:${row.season}`),
  );

describe('Library v4 documents', () => {
  it('reads documents and shows them as the title and episode rows the web draws', async () => {
    const server = await edge([
      filmDocument(550),
      {
        format: 4,
        kind: 'season',
        title: { type: 'tv', id: 1399 },
        season: 1,
        seasonReset: null,
        episodes: {
          2: {
            progress: { value: 0.5, at: at(3000), viewing: 0, seconds: 900, playing: true },
            imported: false,
            plays: {},
            cleared: null,
          },
        },
      },
      prefs,
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(log.wireMinimum).toBe(4);
    expect(log.title({ type: 'movie', id: 550 })?.status.value).toBe('watchlist');
    // An absent field reads as import-owned, at the zero stamp.
    expect(log.title({ type: 'movie', id: 550 })?.reaction).toEqual({
      value: null,
      at: [0, 0, ''],
    });
    expect(log.episode({ type: 'tv', id: 1399 }, 1, 2)?.progress).toMatchObject({
      value: 0.5,
      seconds: 900,
      playing: true,
    });
    expect(log.settings('prefs')?.values['den.hideAnime']).toBeDefined();
    expect(
      log
        .rows()
        .map((row) => row.kind)
        .sort(),
    ).toEqual(['ep', 'rec', 'set']);
  });

  it('writes an edit as den-core writes it, compressed, and only the document it touches', async () => {
    const server = await edge([filmDocument(550)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const before = log.title({ type: 'movie', id: 550 })!;
    expect(await log.write(react(before, 'love', at(4000)))).not.toBeNull();

    const stored = [...server.stored.values()];
    expect(stored).toHaveLength(1);
    // A document is sealed as 0x00 + DEFLATE (§4), not as JSON.
    const keys = server.keys as LibraryKeys;
    const opened = await openEntry(keys, stored[0]!.k, stored[0]!.v);
    expect('row' in opened && opened.row).toMatchObject({
      kind: 'title',
      reaction: { value: 'love', at: at(4000) },
      status: { value: 'watchlist' },
    });
    expect(log.title({ type: 'movie', id: 550 })?.reaction.value).toBe('love');
  });

  it("derives a write again on another device's version of the document, keeping both changes", async () => {
    const server = await edge([filmDocument(550)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const before = log.title({ type: 'movie', id: 550 })!;
    // The TV reacts to the same title after this browser read it.
    await server.append(filmDocument(550, { reaction: { value: 'like', at: at(5000) } }));

    expect(await log.write({ ...before, dismissed: { value: true, at: at(4000) } })).not.toBeNull();
    const held = document(await server.opened(), 'title:movie:550')!;
    expect(held.reaction).toEqual({ value: 'like', at: at(5000) });
    expect(held.dismissed).toEqual({ value: true, at: at(4000) });
  });

  it('writes marking a season seen as one season document, with no history rows', async () => {
    const server = await edge([filmDocument(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const ref = { type: 'tv' as const, id: 1399 };
    const journals = [1, 2, 3].map((episode, index) => {
      const before = blankEpisode(ref, 1, episode);
      return recordTrackerEvent(
        before,
        markEpisode(before, true, at(6000 + index)),
        at(6000 + index),
      )!;
    });
    expect(await log.writeActions(journals)).toBe(true);
    const stored = await server.opened();
    expect(stored.some((row) => row.kind === 'set')).toBe(false);
    const season = document(stored, 'season:tv:1399:1')!;
    expect(Object.keys(season.episodes as object).sort()).toEqual(['1', '2', '3']);
    expect(log.episode(ref, 1, 3)?.progress.value).toBe(1);
  });

  it('writes no tracker-event or episode row from a kept v4 library whose minimum this browser never kept', async () => {
    const server = await edge([filmDocument(1)]);
    const { vault, data } = memoryVault();
    const first = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, vault))!;
    await vi.waitFor(() =>
      expect(data.has(`${first.libraryId}:library-facts.v1:manifest`)).toBe(true),
    );
    // The minimum was remembered only in page storage, which the Worker that opens the log cannot read.
    first.close();
    data.delete(`${first.libraryId}:runtime:meta:wireMin`);
    expect([...data.keys()].filter((key) => key.includes('meta'))).toEqual([]);

    // Nothing den-edge answers reaches this browser before the edit: it is drawn and made from the kept copy alone.
    const quiet: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/member')) throw new TypeError('offline');
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, quiet, undefined, vault))!;
    expect(log.fromCache).toBe(true);
    const before = blankEpisode({ type: 'tv', id: 1399 }, 1, 4);
    const journal = recordTrackerEvent(before, markEpisode(before, true, at(7000)), at(7000))!;
    expect(await log.writeAction(journal)).not.toBeNull();
    await log.refresh();

    const stored = await server.opened();
    expect(stored.filter((row) => ['set', 'ep', 'rec', 'wat'].includes(row.kind))).toEqual([]);
    expect(document(stored, 'season:tv:1399:1')).toBeDefined();
  });

  it('keeps a write den-edge refuses for now as den-core writes, and sends it on the next refresh', async () => {
    const server = await edge([filmDocument(550)]);
    const storage = memoryStorage();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, null))!;
    server.log.refuseNext = 'rewrite_in_progress';
    const added = addToWatchlist(blankTitle({ type: 'movie', id: 680 }, 2000), at(7000));
    expect(await log.write(added)).not.toBeNull();
    expect(log.pendingActions).toBe(1);
    // Drawn while it waits.
    expect(log.title({ type: 'movie', id: 680 })?.status.value).toBe('watchlist');
    await log.refresh();
    expect(log.pendingActions).toBe(0);
    expect(document(await server.opened(), 'title:movie:680')?.status).toEqual({
      value: 'watchlist',
      at: at(7000),
    });
  });

  it('takes imported title and episode projections as v4 edits', async () => {
    const server = await edge([filmDocument(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const ref = { type: 'tv' as const, id: 95396 };
    expect(
      await log.writeRows([
        markEpisode(blankEpisode(ref, 2, 4), true, at(3000)),
        markWatched(blankTitle({ type: 'movie', id: 600 }, 3000), at(3100)),
      ]),
    ).toBe(true);
    const stored = await server.opened();
    expect(stored.some((row) => ['rec', 'ep', 'wat'].includes(row.kind))).toBe(false);
    expect(log.episode(ref, 2, 4)?.progress.value).toBe(1);
    expect(log.title({ type: 'movie', id: 600 })?.status.value).toBe('watched');
  });

  it('a kept write sent late never sets a field back past a newer one', () => {
    const film = filmDocument(550, { status: { value: 'watched', at: at(9000) } });
    const before = rec('movie', 550);
    const ops = opsFor(before, { ...before, status: { value: 'none', at: at(8000) } });
    expect(applyOps(ops, (name) => (name === 'title:movie:550' ? film : undefined))).toEqual([]);
  });

  it('reads a newer-format document but writes nothing, and says an update is required', async () => {
    const server = await edge();
    // In the JSON form a known kind may be read in (§4): den-core encodes nothing above format 4.
    const newer = JSON.stringify(filmDocument(550, { format: 5 }));
    server.put(
      await sealPlaintext(server.keys, 'title:movie:550', new TextEncoder().encode(newer)),
    );
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(log.title({ type: 'movie', id: 550 })?.status.value).toBe('watchlist');
    expect(log.upgradeRequired).toBe(5);
    expect(libraryAlert(log)).toBe('Library update required');
    const before = log.title({ type: 'movie', id: 550 })!;
    expect(await log.write(react(before, 'love', at(4000)))).toBeNull();
  });

  /** A row sealed under `name` whose ciphertext was then damaged: it fails to open. */
  const damaged = async (keys: LibraryKeys, name: string) => {
    const sealed = await sealPlaintext(keys, name, new TextEncoder().encode('{}'));
    const at = sealed.v.length - 6;
    return {
      k: sealed.k,
      v: sealed.v.slice(0, at) + (sealed.v[at] === 'A' ? 'B' : 'A') + sealed.v.slice(at + 1),
    };
  };

  it('removes a row that fails to open once read to the head, and delivers nothing until then', async () => {
    const server = await edge([filmDocument(550), prefs]);
    const bad = await damaged(server.keys as LibraryKeys, 'title:movie:999');
    server.put(bad);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, memoryStorage(), null))!;
    expect([...log.unreadable.values()]).toEqual(['open']);
    expect(await log.compact()).toBe(true);
    expect(server.stored.has(bad.k)).toBe(false);
    expect(server.stored.size).toBe(2);
    expect(log.unreadable.size).toBe(0);
    expect(server.log.commits).toEqual([{ base: 3, wireMin: 4 }]);
  });

  it('removes nothing where storage is blocked, since it could not remember what it removed', async () => {
    const server = await edge([filmDocument(550), prefs]);
    const bad = await damaged(server.keys as LibraryKeys, 'title:movie:999');
    server.put(bad);
    const blocked = memoryStorage();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, blocked, null))!;
    blocked.getItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await log.compact()).toBe(false);
    warn.mockRestore();
    expect(server.stored.has(bad.k)).toBe(true);
    expect(server.log.commits).toEqual([]);
    expect(libraryAlert(log)).toBe('Delivery paused: library rows can’t be read');
  });

  it('never removes a row that opens: one this build reads as unreadable another may read', async () => {
    const server = await edge([filmDocument(550), prefs]);
    // Sealed under the name of one document but holding another: it opens, then fails identity (§4).
    const keys = server.keys as LibraryKeys;
    const kept = await sealPlaintext(
      keys,
      'title:movie:999',
      new TextEncoder().encode('{"format":4,"kind":"title","title":{"type":"movie","id":1}}'),
    );
    server.put(kept);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, memoryStorage(), null))!;
    expect([...log.unreadable.values()]).toEqual(['identity']);
    expect(await log.compact()).toBe(false);
    expect(server.stored.get(kept.k)?.v).toBe(kept.v);
    expect(server.log.commits).toEqual([]);
    expect(libraryAlert(log)).toBe('Delivery paused: library rows can’t be read');
  });

  it('leaves too many rows that fail to open alone, and says delivery is paused', async () => {
    const server = await edge([filmDocument(550), prefs]);
    const keys = server.keys as LibraryKeys;
    for (let id = 0; id < 11; id++) server.put(await damaged(keys, `title:movie:${9000 + id}`));
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, memoryStorage(), null))!;
    expect(log.unreadable.size).toBe(11);
    expect(await log.compact()).toBe(false);
    expect(server.log.commits).toEqual([]);
    expect(server.stored.size).toBe(13);
    expect(libraryAlert(log)).toBe('Delivery paused: library rows can’t be read');
  });
});

describe('pre-v4 backups', () => {
  it('refuses an old-format restore read-only with the recorded error', async () => {
    const server = await edge([rec('movie', 550)], { wireMin: 3 });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;

    expect(log.readOnly).toBe(true);
    expect(log.readOnlyReason).toBe(PRE_V4_BACKUP_ERROR);
    expect(await log.write(blankTitle({ type: 'movie', id: 7 }, 1_000))).toBeNull();
    expect(server.log.commits).toEqual([]);
  });
});

describe('SIMKL delivery on Library v4', () => {
  let deliveryVault: Vault;
  beforeEach(() => {
    deliveryVault = memoryVault().vault;
  });

  const trackers: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'trackers',
    values: {
      'simkl:42': { value: { string: JSON.stringify({ access_token: 'token' }) }, at: at(1000) },
    },
  };
  const deliver = (lease: [string, string], t = 500): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name: 'deliver:simkl:42',
    values: {
      since: { value: { string: JSON.stringify(at(500)) }, at: at(500) },
      lease: { value: { strings: lease }, at: at(t) },
    },
  });

  /** den-edge, with SIMKL answering an empty account and counting what it is sent. */
  async function simkl(rows: Row[], options?: Parameters<typeof edge>[1]) {
    const server = await edge(rows, options);
    const sent = { count: 0 };
    const connection: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/config') return new Response(JSON.stringify({ simklClientId: 'client' }));
      if (url.includes('/sync/all-items'))
        return new Response(JSON.stringify({ movies: [], shows: [] }));
      if (url.includes('api.simkl.com') && init?.method === 'POST') {
        sent.count++;
        return new Response('{}');
      }
      return server.fetchImpl(input, init);
    };
    return { server, connection, sent };
  }

  /**
   * A pass from a page that has watched the library for ten minutes: one at `elapsed` − 10 min starts the watch of
   * its generation and delivers nothing, then the pass at `elapsed`.
   */
  async function watched(log: LibraryLog, connection: typeof fetch, elapsed = 600_000) {
    expect(await deliverSimkl(log, DEVICE, connection, elapsed - 600_000)).toBe(false);
    return deliverSimkl(log, DEVICE, connection, elapsed);
  }

  const leaseOf = (rows: Row[]) =>
    rows.find((row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42')!
      .values.lease?.value;

  /** The settle order of every receipt den-edge holds: a watch entry's fifth element, a list or rating's third. */
  const orders = (rows: Row[]) =>
    rows
      .filter((row): row is DocumentRow => row.kind === 'delivery')
      .flatMap((row) =>
        Object.values(row.entries as Record<string, unknown[]>).map((entry) =>
          JSON.stringify(['w', 'u', 'n'].includes(entry[0] as string) ? entry[4] : entry[2]),
        ),
      );

  it('never repeats a settle order within an epoch, pass after pass', async () => {
    const { server, connection } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await watched(log, connection)).toBe(true);
    await server.append(filmDocument(551));
    await log.refresh();
    expect(await deliverSimkl(log, DEVICE, connection, 600_000)).toBe(true);
    const all = orders(await server.opened());
    expect(all.length).toBeGreaterThan(2);
    expect(new Set(all).size).toBe(all.length);
  });

  it('takes the lease past every settle epoch its receipts hold', async () => {
    const receipts: DocumentRow = {
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
      entries: { list: ['in', at(1000), [7, 3, 'bbbbbbbbbbbbbbbb']] },
    };
    const { server, connection } = await simkl([
      filmDocument(550),
      receipts,
      trackers,
      deliver(['bbbbbbbbbbbbbbbb', '2']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await watched(log, connection)).toBe(true);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '8'] });
  });

  it('takes the lease compare-and-set: another device that renewed it since keeps it', async () => {
    const { server, connection, sent } = await simkl([
      filmDocument(550),
      trackers,
      deliver(['', '1']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    // The TV renews its lease after this browser read the row, with an older stamp than this browser would issue.
    await server.append(deliver(['cccccccccccccccc', '3'], 600));
    expect(await watched(log, connection)).toBe(false);
    expect(sent.count).toBe(0);
    const lease = (await server.opened()).find(
      (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
    )!.values.lease?.value;
    expect(lease).toEqual({ strings: ['cccccccccccccccc', '3'] });
  });

  it('sends what is pending once, and keeps its receipt in a delivery document', async () => {
    const { server, connection, sent } = await simkl([
      filmDocument(550),
      trackers,
      deliver(['', '1']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await watched(log, connection)).toBe(true);
    expect(sent.count).toBe(1);
    const receipts = (await server.opened()).find((row) => row.kind === 'delivery') as DocumentRow;
    expect(receipts).toMatchObject({
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
    });
    expect((receipts.entries as Record<string, unknown[]>).list?.[0]).toBe('in');
    expect(await deliverSimkl(log, DEVICE, connection, 600_000)).toBe(true);
    expect(sent.count).toBe(1);
  });

  it('a lease refused by a generation change reads the new log, and a later pass takes it', async () => {
    const { server, connection } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await deliverSimkl(log, DEVICE, connection, 0)).toBe(false);
    // The library is restored between this browser's read and its lease write: a new generation.
    await server.append(filmDocument(551));
    server.restore();
    expect(await deliverSimkl(log, DEVICE, connection, 600_000)).toBe(false);
    expect(log.title({ type: 'movie', id: 551 })).toBeDefined();
    expect(await watched(log, connection, 1_200_000)).toBe(true);
  });

  it('after a generation change, watches the new store before taking even its own lease, at a new epoch', async () => {
    const { server, connection } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await watched(log, connection)).toBe(true);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '2'] });
    // A restore: a new generation whose lease row still names this browser.
    server.restore();
    await log.refresh();
    expect(await deliverSimkl(log, DEVICE, connection, 610_000)).toBe(false);
    expect(await deliverSimkl(log, DEVICE, connection, 1_209_999)).toBe(false);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '2'] });
    expect(await deliverSimkl(log, DEVICE, connection, 1_210_000)).toBe(true);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '3'] });
  });

  it("takes another device's lease only once its row has stayed unchanged for ten minutes", async () => {
    const { server, connection, sent } = await simkl([
      filmDocument(550),
      trackers,
      deliver(['cccccccccccccccc', '3']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    // A page open for ten minutes is no reason to take a lease the TV renewed a moment ago.
    expect(await watched(log, connection)).toBe(true);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '4'] });

    // The TV takes it back, and renews it while this page watches: each renewal starts the ten minutes over. Its
    // stamps are fresh, as a real TV's are.
    await server.append(deliver(['cccccccccccccccc', '5'], Date.now() + 60_000));
    await log.refresh();
    expect(await deliverSimkl(log, DEVICE, connection, 700_000)).toBe(false);
    await server.append(deliver(['cccccccccccccccc', '5'], Date.now() + 120_000));
    await log.refresh();
    expect(await deliverSimkl(log, DEVICE, connection, 1_200_000)).toBe(false);
    expect(await deliverSimkl(log, DEVICE, connection, 1_799_999)).toBe(false);
    expect(await deliverSimkl(log, DEVICE, connection, 1_800_000)).toBe(true);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '6'] });
    expect(sent.count).toBe(1);
  });

  it('a page that kept no generation watches before taking even an empty lease', async () => {
    const { connection, sent } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await deliverSimkl(log, DEVICE, connection, 900_000)).toBe(false);
    expect(await deliverSimkl(log, DEVICE, connection, 1_499_999)).toBe(false);
    expect(sent.count).toBe(0);
    expect(await deliverSimkl(log, DEVICE, connection, 1_500_000)).toBe(true);
    expect(sent.count).toBe(1);
  });

  it('decides a mass list removal once it is approved, where the latch held it before', async () => {
    const removed = Array.from({ length: 21 }, (_, i) =>
      filmDocument(600 + i, { deleted: { value: true, at: at(3000) } }),
    );
    const receipts: DocumentRow[] = removed.map((doc) => ({
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: doc.title,
      entries: { list: ['in', at(1000), [1, 1, 'bbbbbbbbbbbbbbbb']] },
    }));
    const lists = (rows: Row[]) =>
      rows
        .filter((row): row is DocumentRow => row.kind === 'delivery')
        .map((row) => (row.entries as Record<string, unknown[]>).list?.[0]);
    const delivered = async (removals?: unknown) => {
      const row = deliver(['', '1']);
      if (removals)
        row.values.removals = { value: { string: JSON.stringify(removals) }, at: at(4000) };
      // SIMKL's account no longer lists them, so each removal, once decided, settles as delivered.
      const { server, connection } = await simkl([...removed, ...receipts, trackers, row]);
      const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
      expect(await watched(log, connection)).toBe(true);
      const opened = await server.opened();
      const latch = opened.find(
        (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
      )!.values.removals?.value;
      return {
        lists: lists(opened),
        latch: latch && 'string' in latch ? (JSON.parse(latch.string) as object) : null,
        held: heldSimklRemovals(log).titles.length,
      };
    };
    // More than 20 removals hold every one of them, pass after pass, and the holder closes the latch on the row.
    expect(await delivered()).toEqual({
      lists: Array(21).fill('in'),
      latch: { held: expect.any(Array) },
      held: 21,
    });
    // Approved after they were made: every one is decided.
    expect((await delivered({ approved: at(4000) })).lists).toEqual(Array(21).fill('gone'));
  });

  it('holds 21 more removals after an approval alone: the 21 approved still go out', async () => {
    const batch = (from: number, removedAt: number) =>
      Array.from({ length: 21 }, (_, i) =>
        filmDocument(from + i, { deleted: { value: true, at: at(removedAt) } }),
      );
    const approvedBatch = batch(600, 3000);
    const laterBatch = batch(700, 6000);
    const titles = [...approvedBatch, ...laterBatch];
    const receipts: DocumentRow[] = titles.map((doc) => ({
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: doc.title,
      entries: { list: ['in', at(1000), [1, 1, 'bbbbbbbbbbbbbbbb']] },
    }));
    const row = deliver(['', '1']);
    row.values.removals = {
      value: { string: JSON.stringify({ approved: at(4000) }) },
      at: at(4000),
    };
    const { server, connection, sent } = await simkl([...titles, ...receipts, trackers, row]);
    // SIMKL lists all 42, added long before, so a decided removal is a request; the first pass's requests fail.
    let failing = true;
    const listing: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/sync/all-items'))
        return new Response(
          JSON.stringify({
            movies: titles.map((doc) => ({
              movie: { ids: { tmdb: doc.title.id } },
              status: 'plantowatch',
              added_to_watchlist_at: '1970-01-01T00:00:01Z',
            })),
          }),
        );
      if (failing && url.includes('api.simkl.com') && init?.method === 'POST')
        return new Response('{}', { status: 503 });
      return connection(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, listing, undefined, deliveryVault))!;
    expect(await watched(log, listing)).toBe(true);
    const latch = (await server.opened()).find(
      (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
    )!.values.removals?.value as { string: string };
    expect(Object.keys(JSON.parse(latch.string) as object).sort()).toEqual(['approved', 'held']);

    failing = false;
    await log.refresh();
    expect(await deliverSimkl(log, DEVICE, listing, 600_000)).toBe(true);
    // A failed external request was already reserved. For 120 seconds the safety latch counts those attempts too,
    // rather than risking a retry storm that bypasses the removal limit.
    expect(sent.count).toBe(0);
    expect(heldSimklRemovals(log).titles.map(({ id }) => id)).toEqual(
      laterBatch.map((doc) => doc.title.id),
    );
  });

  it('sends a removal SIMKL still lists, once it knows when SIMKL listed it', async () => {
    const receipts: DocumentRow = {
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
      entries: { list: ['in', at(1000), [1, 1, 'bbbbbbbbbbbbbbbb']] },
    };
    const { connection, sent } = await simkl([
      filmDocument(550, { deleted: { value: true, at: at(3000) } }),
      receipts,
      trackers,
      deliver(['', '1']),
    ]);
    const listing: typeof fetch = async (input, init) =>
      String(input).includes('/sync/all-items')
        ? new Response(
            JSON.stringify({
              movies: [
                {
                  movie: { ids: { tmdb: 550 } },
                  status: 'plantowatch',
                  added_to_watchlist_at: '1970-01-01T00:00:01Z',
                },
              ],
            }),
          )
        : connection(input, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, listing, undefined, deliveryVault))!;
    expect(await watched(log, listing)).toBe(true);
    expect(sent.count).toBe(1);
  });

  it('writes an epoch two devices settled under to unverified, and decides its receipts again', async () => {
    const receipt = (id: number, device: string): DocumentRow => ({
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id },
      entries: { list: ['in', at(1000), [3, 1, device]] },
    });
    const { server, connection, sent } = await simkl([
      filmDocument(550),
      filmDocument(551),
      receipt(550, 'bbbbbbbbbbbbbbbb'),
      receipt(551, 'cccccccccccccccc'),
      trackers,
      deliver(['', '1']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await watched(log, connection)).toBe(true);
    expect(sent.count).toBe(2);
    const row = (await server.opened()).find(
      (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
    )!;
    expect(row.values.unverified?.value).toEqual({ ints: [3] });
  });

  it('checks its hold on the lease before every request, and stops once it has lapsed', async () => {
    const { connection, sent } = await simkl([
      filmDocument(550),
      filmDocument(551),
      trackers,
      deliver(['', '1']),
    ]);
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    try {
      // The first request takes longer than the two minutes a hold lasts.
      const slow: typeof fetch = async (input, init) => {
        const res = await connection(input, init);
        if (String(input).includes('api.simkl.com') && init?.method === 'POST')
          vi.advanceTimersByTime(121_000);
        return res;
      };
      const log = (await LibraryLog.open(LIBRARY_KEY, slow, undefined, deliveryVault))!;
      expect(await watched(log, slow)).toBe(true);
      expect(sent.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts Date.now stepping back as the hold lapsing, whatever performance.now says', async () => {
    const { connection, sent } = await simkl([
      filmDocument(550),
      filmDocument(551),
      trackers,
      deliver(['', '1']),
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // The wall clock steps back an hour during the first request; performance.now runs on.
      let stepped = false;
      const stepping: typeof fetch = async (input, init) => {
        const res = await connection(input, init);
        if (!stepped && String(input).includes('api.simkl.com') && init?.method === 'POST') {
          stepped = true;
          vi.setSystemTime(Date.now() - 3_600_000);
        }
        return res;
      };
      const log = (await LibraryLog.open(LIBRARY_KEY, stepping, undefined, deliveryVault))!;
      expect(await watched(log, stepping)).toBe(true);
      expect(sent.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('watches on the lesser of its clocks: a wall clock that jumps ahead is no ten minutes', async () => {
    const { connection, sent } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // The page's own clocks, as `deliverSimkl` reads them when given no `elapsed`.
      expect(await deliverSimkl(log, DEVICE, connection)).toBe(false);
      vi.setSystemTime(Date.now() + 660_000);
      expect(await deliverSimkl(log, DEVICE, connection)).toBe(false);
      expect(sent.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('approves exactly what was shown, by compare-and-set; a hold written meanwhile shows the list again', async () => {
    const removed = Array.from({ length: 21 }, (_, i) =>
      filmDocument(600 + i, { deleted: { value: true, at: at(3000) } }),
    );
    const receipts: DocumentRow[] = removed.map((doc) => ({
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: doc.title,
      entries: { list: ['in', at(1000), [1, 1, 'bbbbbbbbbbbbbbbb']] },
    }));
    const { server, connection } = await simkl([
      ...removed,
      ...receipts,
      trackers,
      deliver(['', '1']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    const shown = heldSimklRemovals(log);
    expect(shown.titles).toHaveLength(21);
    expect(shown.approval).toEqual(at(3000));

    // The TV, holding the lease, closes the latch while the person looks at the list.
    const closed = deliver(['bbbbbbbbbbbbbbbb', '2'], 5000);
    closed.values.removals = {
      value: { string: JSON.stringify({ held: at(3000) }) },
      at: at(5000),
    };
    await server.append(closed);
    const latch = async () =>
      JSON.parse(
        (
          (await server.opened()).find(
            (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
          )!.values.removals?.value as { string: string }
        ).string,
      ) as unknown;
    expect(await approveSimklRemovals(log, DEVICE, shown)).toBe(false);
    expect(await latch()).toEqual({ held: at(3000) });

    await log.refresh();
    const again = heldSimklRemovals(log);
    expect(await approveSimklRemovals(log, DEVICE, again)).toBe(true);
    expect(await latch()).toEqual({ approved: at(3000), held: at(3000) });
    expect(heldSimklRemovals(log).titles).toEqual([]);
  });

  /** Films removed at `removedAt`, each with an `in` receipt from another device. */
  const removedFilms = (from: number, count: number, removedAt: (i: number) => number) => {
    const titles = Array.from({ length: count }, (_, i) =>
      filmDocument(from + i, { deleted: { value: true, at: at(removedAt(i)) } }),
    );
    const receipts: DocumentRow[] = titles.map((doc) => ({
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: doc.title,
      entries: { list: ['in', at(1000), [1, 1, 'bbbbbbbbbbbbbbbb']] },
    }));
    return [...titles, ...receipts];
  };

  it('approves past the stored held when the removal that closed the latch was undone', async () => {
    // 25 removals closed the latch at the 25th's stamp; that title is back, so 24 stay held.
    const row = deliver(['', '1']);
    row.values.removals = { value: { string: JSON.stringify({ held: at(3024) }) }, at: at(5000) };
    const { server, connection } = await simkl([
      ...removedFilms(600, 24, (i) => 3000 + i),
      trackers,
      row,
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    const shown = heldSimklRemovals(log);
    expect(shown.titles).toHaveLength(24);
    expect(shown.approval).toEqual(at(3024));
    expect(await approveSimklRemovals(log, DEVICE, shown)).toBe(true);
    const latch = (await server.opened()).find(
      (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
    )!.values.removals?.value as { string: string };
    expect(JSON.parse(latch.string)).toEqual({ approved: at(3024), held: at(3024) });
    expect(heldSimklRemovals(log).titles).toEqual([]);
  });

  it('shares the removals sent across tabs: a late batch after 21 sent is held in another tab', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    try {
      const approvedBatch = removedFilms(600, 21, () => 3000);
      const row = deliver(['', '1']);
      row.values.removals = {
        value: { string: JSON.stringify({ approved: at(4000), held: at(4000) }) },
        at: at(4000),
      };
      const { server, connection, sent } = await simkl([...approvedBatch, trackers, row]);
      // SIMKL lists every title, added long before, so each approved removal is a request.
      const listing: typeof fetch = async (input, init) =>
        String(input).includes('/sync/all-items')
          ? new Response(
              JSON.stringify({
                movies: Array.from({ length: 22 }, (_, i) => ({
                  movie: { ids: { tmdb: 600 + i } },
                  status: 'plantowatch',
                  added_to_watchlist_at: '1970-01-01T00:00:01Z',
                })),
              }),
            )
          : connection(input, init);
      const tab = (await LibraryLog.open(LIBRARY_KEY, listing, undefined, deliveryVault))!;
      expect(await watched(tab, listing)).toBe(true);
      expect(sent.count).toBe(21);

      // An offline device's removal stamped before the approval arrives; another tab reads it.
      for (const document of removedFilms(621, 1, () => 3000)) await server.append(document);
      const other = (await LibraryLog.open(LIBRARY_KEY, listing, undefined, deliveryVault))!;
      expect(await deliverSimkl(other, DEVICE, listing, 600_000)).toBe(true);
      expect(sent.count).toBe(21);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a list add again whose receipt is unverified', async () => {
    const receipts: DocumentRow = {
      format: 4,
      kind: 'delivery',
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
      entries: { list: ['in', at(1000), [3, 1, 'bbbbbbbbbbbbbbbb']] },
    };
    const unverified: SettingsRow = {
      ...deliver(['', '1']),
      values: { ...deliver(['', '1']).values, unverified: { value: { ints: [3] }, at: at(4000) } },
    };
    const { connection, sent } = await simkl([filmDocument(550), receipts, trackers, unverified]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, deliveryVault))!;
    expect(await watched(log, connection)).toBe(true);
    expect(sent.count).toBe(1);
  });
});

describe('an edit answered before it is sent', () => {
  const ref = { type: 'movie' as const, id: 550 };

  /** A log on a vault, whose sends to den-edge wait for `release`, or fail as `answer` says. */
  async function held(answer?: (init: RequestInit) => Response | Promise<Response>) {
    const server = await edge([filmDocument(550)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const batches: string[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      if (String(input).endsWith('/batch') && init.method === 'POST') {
        batches.push('batch');
        await gate;
        const refused = await answer?.(init);
        if (refused) return refused;
      }
      return server.fetchImpl(input, init);
    };
    const { vault, data } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, vault))!;
    const settled: Array<{ outcome: string; changed: boolean }> = [];
    const next = () => vi.waitFor(() => expect(settled.length).toBeGreaterThan(0));
    log.onDeferred = (delivery) => settled.push(delivery);
    return { server, log, release, batches, settled, next, data };
  }

  it('resolves once the edit is kept and drawn, and sends it after', async () => {
    const { server, log, release, batches, settled, next } = await held();
    const before = log.title(ref)!;
    const saved = await log.write(react(before, 'love', at(4000)));

    // The wait for den-edge is still on, and the edit is already what this browser shows and keeps.
    expect(saved).not.toBeNull();
    expect(log.title(ref)?.reaction.value).toBe('love');
    expect(log.pendingActions).toBe(1);
    expect(log.queuedActions).toBe(0);
    expect(document(await server.opened(), 'title:movie:550')?.reaction).toBeUndefined();

    release();
    await next();
    expect(batches).toHaveLength(1);
    expect(settled).toEqual([{ outcome: 'sent', changed: false }]);
    expect(document(await server.opened(), 'title:movie:550')?.reaction).toEqual({
      value: 'love',
      at: at(4000),
    });
    expect(log.pendingActions).toBe(0);
  });

  it('builds a second edit on the first while the first is still being sent', async () => {
    const { server, log, release, settled } = await held();
    await log.write(react(log.title(ref)!, 'love', at(4000)));
    await log.write({ ...log.title(ref)!, dismissed: { value: true, at: at(4001) } });
    expect(log.title(ref)).toMatchObject({
      reaction: { value: 'love' },
      dismissed: { value: true },
    });

    release();
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    const stored = document(await server.opened(), 'title:movie:550')!;
    expect(stored.reaction).toEqual({ value: 'love', at: at(4000) });
    expect(stored.dismissed).toEqual({ value: true, at: at(4001) });
    expect(log.pendingActions).toBe(0);
  });

  it('keeps the edit, queued, when den-edge cannot be reached', async () => {
    const { log, release, settled, next } = await held(() => {
      throw new TypeError('network down');
    });
    expect(await log.write(react(log.title(ref)!, 'love', at(4000)))).not.toBeNull();

    release();
    await next();
    expect(settled).toEqual([{ outcome: 'kept', changed: false }]);
    expect(log.title(ref)?.reaction.value).toBe('love');
    expect(log.pendingActions).toBe(1);
    expect(log.queuedActions).toBe(1);
  });

  it('takes the edit back out, and logs why, when den-edge refuses it for good', async () => {
    const { log, release, settled, next, data } = await held(
      () => new Response(JSON.stringify({ error: 'invalid_batch' }), { status: 400 }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const keptEdits = () => [...data.keys()].filter((key) => key.includes(':ops:'));
    expect(await log.write(react(log.title(ref)!, 'love', at(4000)))).not.toBeNull();
    expect(log.title(ref)?.reaction.value).toBe('love');
    expect(keptEdits()).toHaveLength(1);

    release();
    await next();
    expect(settled).toEqual([{ outcome: 'refused', changed: true }]);
    expect(log.title(ref)?.reaction.value).toBeNull();
    expect(log.pendingActions).toBe(0);
    expect(keptEdits()).toHaveLength(0);
    expect(log.refusal).toBe('invalid_batch');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('refused a library write'));
    error.mockRestore();
    warn.mockRestore();
  });

  it('says the rows changed when another device had written the document first', async () => {
    const { server, log, release, settled, next } = await held();
    await log.write({ ...log.title(ref)!, dismissed: { value: true, at: at(4000) } });
    await server.append(filmDocument(550, { reaction: { value: 'like', at: at(5000) } }));

    release();
    await next();
    expect(settled).toEqual([{ outcome: 'sent', changed: true }]);
    const stored = document(await server.opened(), 'title:movie:550')!;
    expect(stored.reaction).toEqual({ value: 'like', at: at(5000) });
    expect(stored.dismissed).toEqual({ value: true, at: at(4000) });
  });

  it('still waits for den-edge when there is nowhere to keep the edit', async () => {
    const server = await edge([filmDocument(550)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      if (String(input).endsWith('/batch') && init.method === 'POST') await gate;
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, null))!;
    let resolved = false;
    const write = log.write(react(log.title(ref)!, 'love', at(4000))).then((row) => {
      resolved = true;
      return row;
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(resolved).toBe(false);
    release();
    expect(await write).not.toBeNull();
  });
});

describe('a settings row riding with an edit (assistant v1 §6)', () => {
  const ref = { type: 'movie' as const, id: 550 };
  const applied = (id: string, at: Stamp): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name: 'assistant-applied',
    values: { [id]: { value: { string: `{"applied":1,"at":1,"grant":"${id}"}` }, at } },
  });

  async function riding(rows: Row[] = []) {
    const server = await edge([filmDocument(550), ...rows]);
    const batches: number[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      if (String(input).endsWith('/batch') && init.method === 'POST')
        batches.push((JSON.parse(String(init.body)) as { writes: unknown[] }).writes.length);
      return server.fetchImpl(input, init);
    };
    const { vault } = memoryVault();
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, vault))!;
    const settled: unknown[] = [];
    log.onDeferred = (delivery) => settled.push(delivery);
    return { server, log, batches, settled };
  }

  const stored = async (server: Awaited<ReturnType<typeof edge>>) =>
    (await server.opened()).find(
      (row): row is SettingsRow => row?.kind === 'set' && row.name === 'assistant-applied',
    );

  it('goes in the same batch as the edit, and only with it', async () => {
    const { server, log, batches, settled } = await riding();
    const before = log.title(ref)!;
    const event = recordTrackerEvent(before, react(before, 'love', at(4000)), at(4000), 'op')!;
    expect(
      await log.withRider(applied('a'.repeat(32), at(5000)), () => log.writeAction(event)),
    ).toBe(true);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(batches).toEqual([2]);
    expect(Object.keys((await stored(server))!.values)).toEqual(['a'.repeat(32)]);
    expect(document(await server.opened(), 'title:movie:550')?.reaction).toEqual({
      value: 'love',
      at: at(4000),
    });
    // Work that makes no edit carries nothing: the caller writes the row itself.
    expect(await log.withRider(applied('b'.repeat(32), at(6000)), async () => {})).toBe(false);
    expect(batches).toEqual([2]);
  });

  it('is merged with another device’s version and sent again with the edit on a conflict', async () => {
    const { server, log, settled } = await riding();
    // Another device recorded a request after this browser read the log.
    await server.append(applied('c'.repeat(32), at(3000)));
    const before = log.title(ref)!;
    const event = recordTrackerEvent(before, react(before, 'like', at(4000)), at(4000), 'op')!;
    await log.withRider(applied('d'.repeat(32), at(5000)), () => log.writeAction(event));
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(Object.keys((await stored(server))!.values).sort()).toEqual([
      'c'.repeat(32),
      'd'.repeat(32),
    ]);
    expect(document(await server.opened(), 'title:movie:550')?.reaction).toEqual({
      value: 'like',
      at: at(4000),
    });
  });
});

describe('an edit made on a log of its own documents (LibraryLog.openNarrow)', () => {
  const ref = { type: 'movie' as const, id: 550 };
  const names = ['title:movie:550', 'rec:movie:550'];
  const sent = (log: LibraryLog) => vi.waitFor(() => expect(log.pendingActions).toBe(0));

  /** A library this browser has opened whole, so its fact store is complete and its membership kept. */
  async function openedHere(fetchWrap?: (inner: typeof fetch) => typeof fetch) {
    const server = await edge([filmDocument(1), filmDocument(2), filmDocument(550)]);
    const fetchImpl = fetchWrap ? fetchWrap(server.fetchImpl) : server.fetchImpl;
    const { vault } = memoryVault();
    const full = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, vault))!;
    expect(full.title(ref)?.status.value).toBe('watchlist');
    full.close();
    return { server, fetchImpl, vault };
  }

  it('reads only the documents it names, and its edit reaches den-edge whole', async () => {
    const { server, fetchImpl, vault } = await openedHere();
    const narrow = await LibraryLog.openNarrow(LIBRARY_KEY, names, fetchImpl, vault);
    expect(narrow, 'opened narrow').not.toBeNull();
    expect(narrow!.title(ref)?.status.value).toBe('watchlist');
    expect(
      narrow!.title({ type: 'movie', id: 1 }),
      'the other titles are not read',
    ).toBeUndefined();

    await narrow!.write(react(narrow!.title(ref)!, 'love', at(4000)));
    await sent(narrow!);
    narrow!.close();

    const stored = document(await server.opened(), 'title:movie:550');
    expect(stored?.reaction).toEqual({ value: 'love', at: at(4000) });
    expect(stored?.status, 'the rest of the document kept').toEqual({
      value: 'watchlist',
      at: at(1000),
    });
  });

  it('declines a browser with no fact store', async () => {
    const { fetchImpl } = await openedHere();
    expect(
      await LibraryLog.openNarrow(LIBRARY_KEY, names, fetchImpl, memoryVault().vault),
    ).toBeNull();
  });

  it('declines while work is kept on this device', async () => {
    let unreachable = false;
    const { fetchImpl, vault } = await openedHere((inner) => async (input, init) => {
      if (unreachable && init?.method === 'POST') throw new TypeError('network down');
      return inner(input, init);
    });
    const full = (await LibraryLog.open(LIBRARY_KEY, fetchImpl, undefined, vault))!;
    unreachable = true;
    await full.write(react(full.title(ref)!, 'like', at(4000)));
    await vi.waitFor(() => expect(full.queuedActions, 'kept, not sent').toBe(1));
    full.close();
    expect(await LibraryLog.openNarrow(LIBRARY_KEY, names, fetchImpl, vault)).toBeNull();
  });
});

function memoryVault() {
  const data = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (k) => data.get(k),
    entries: async (prefix) => [...data].filter(([key]) => key.startsWith(prefix)),
    put: async (k, value) => void data.set(k, value),
    delete: async (key) => void data.delete(key),
    remove: async (prefix) => {
      for (const k of [...data.keys()]) if (k.startsWith(prefix)) data.delete(k);
    },
    page: async (prefix, after, limit) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit),
    commit: async (changes) => {
      for (const change of changes) {
        if (change.kind === 'put') data.set(change.key, change.value.slice());
        else data.delete(change.key);
      }
    },
  };
  return { data, vault };
}

/** localStorage, with a browser's quota when `quota` (in characters) is given. */
function memoryStorage(quota = Infinity): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      let used = k.length + v.length;
      for (const [key, value] of data) if (key !== k) used += key.length + value.length;
      if (used > quota) throw new DOMException('quota exceeded', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  } as Storage;
}
