import { describe, expect, it, vi } from 'vitest';
import {
  addToWatchlist,
  blankEpisode,
  blankTitle,
  markEpisode,
  markWatched,
  react,
} from './actions';
import { libraryAlert } from './librarySession.svelte';
import { switchLibraryToV4 } from './libraryUpgrade';
import { applyOps, opsFor } from './libraryV4';
import { LibraryLog } from './log';
import { deliverSimkl } from './simklDelivery';
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
  type WatchRow,
} from './wire';

// The dry run is den-core's, and on a well-formed log it passes; this lets one test make it fail.
const dryRun = vi.hoisted(() => ({ fail: false }));
vi.mock('./syncCore', async (original) => {
  const real = await original<typeof import('./syncCore')>();
  return {
    syncPolicy: <T>(request: Record<string, unknown>): T =>
      request.op === 'v4_dry_run' && dryRun.fail
        ? ({
            pass: false,
            abort: [{ reason: 'derived', title: 'title:tv:1399', field: 'status' }],
            pending_differences: [],
            counts: {},
          } as T)
        : real.syncPolicy<T>(request),
  };
});

const LIBRARY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const DEVICE = 'aaaaaaaaaaaaaaaa';
const at = (t: number): Stamp => [t, 0, DEVICE];

const rec = (type: 'movie' | 'tv', id: number, overrides: Partial<TitleRow> = {}): TitleRow => ({
  ...blankTitle({ type, id }, 1000),
  status: { value: 'watchlist', at: at(1000) },
  ...overrides,
});

const watch: WatchRow = {
  kind: 'wat',
  schema: 3,
  title: { type: 'tv', id: 1399 },
  season: 1,
  block: 0,
  seasonReset: null,
  entries: {
    2: {
      imported: false,
      progress: { value: 1, at: at(2000), viewing: 0 },
      plays: { 0: 2000 },
      cleared: null,
    },
  },
};

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
  return { keys, fetchImpl, stored, append, put, opened, log, wireMin: () => wireMin };
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
            progress: { value: 0.5, at: at(3000), viewing: 0, seconds: 900 },
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
    });
    expect(log.settings('prefs')?.values['den.hideAnime']).toBeDefined();
    expect(
      log
        .rows()
        .map((row) => row.kind)
        .sort(),
    ).toEqual(['rec', 'set', 'wat']);
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

  it('takes an import as edits, and v3 rows of a library moving in as their documents', async () => {
    const server = await edge([filmDocument(1)]);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const ref = { type: 'tv' as const, id: 95396 };
    expect(
      await log.writeRows([
        markEpisode(blankEpisode(ref, 2, 4), true, at(3000)),
        markWatched(blankTitle({ type: 'movie', id: 600 }, 3000), at(3100)),
        watch,
      ]),
    ).toBe(true);
    const stored = await server.opened();
    expect(stored.some((row) => ['rec', 'ep', 'wat'].includes(row.kind))).toBe(false);
    expect(log.episode(ref, 2, 4)?.progress.value).toBe(1);
    expect(log.title({ type: 'movie', id: 600 })?.status.value).toBe('watched');
    expect(log.episode({ type: 'tv', id: 1399 }, 1, 2)?.progress.value).toBe(1);
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

  it('removes an unreadable row once read to the head, and delivers nothing until then', async () => {
    const server = await edge([filmDocument(550), prefs]);
    // Sealed under the name of one document but holding another: it can't be attributed to a name (§4).
    const keys = server.keys as LibraryKeys;
    const bad = await sealPlaintext(
      keys,
      'title:movie:999',
      new TextEncoder().encode('{"format":4,"kind":"title","title":{"type":"movie","id":1}}'),
    );
    server.put(bad);
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect([...log.unreadable.values()]).toEqual(['identity']);
    expect(await log.compact()).toBe(true);
    expect(server.stored.has(bad.k)).toBe(false);
    expect(server.stored.size).toBe(2);
    expect(log.unreadable.size).toBe(0);
    expect(server.log.commits).toEqual([{ base: 3, wireMin: 4 }]);
  });
});

describe('the switch to Library v4', () => {
  const v3 = () => [
    rec('tv', 1399),
    watch,
    prefs,
    rec('movie', 550, { reaction: { value: 'love', at: at(1500) } }),
  ];

  it('converts a v3 library, checked, and commits it at minimum 4', async () => {
    const server = await edge(v3(), { wireMin: 3 });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(log.needsV4).toBe(true);
    expect(await switchLibraryToV4(log, Date.now(), server.fetchImpl)).toBe(true);

    expect(server.log.commits).toEqual([{ base: 4, wireMin: 4 }]);
    expect(log.wireMinimum).toBe(4);
    const stored = await server.opened();
    expect(stored.map((row) => row.kind).sort()).toEqual(['season', 'set', 'title', 'title']);
    expect(log.title({ type: 'movie', id: 550 })?.reaction.value).toBe('love');
    expect(log.episode({ type: 'tv', id: 1399 }, 1, 2)?.progress.value).toBe(1);
    // Settings are staged as they were stored.
    expect(log.settings('prefs')).toEqual(prefs);
    expect(log.needsV4).toBe(false);
    expect(libraryAlert(log)).toBeNull();
  });

  it('aborts on a derived-state difference: writes nothing, says why, and stays read-only', async () => {
    const server = await edge(v3(), { wireMin: 3 });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dryRun.fail = true;
    try {
      expect(await switchLibraryToV4(log, Date.now(), server.fetchImpl)).toBe(false);
    } finally {
      dryRun.fail = false;
    }
    expect(error).toHaveBeenCalledWith(
      'den: the switch to Library v4 was aborted by its dry run',
      expect.arrayContaining([expect.objectContaining({ title: 'title:tv:1399' })]),
    );
    error.mockRestore();
    expect(server.log.commits).toEqual([]);
    expect(server.log.aborted).toBe(1);
    expect(server.wireMin()).toBe(3);
    expect(log.wireMinimum).toBe(3);
    expect(libraryAlert(log)).toBe('Library update failed: derived');
    expect(log.readOnly).toBe(true);
    expect(
      await log.write(react(log.title({ type: 'movie', id: 550 })!, 'like', at(9000))),
    ).toBeNull();
    // Tried again only after an hour, and then it goes through.
    expect(await switchLibraryToV4(log, Date.now() + 60_000, server.fetchImpl)).toBe(false);
    expect(await switchLibraryToV4(log, Date.now() + 3_600_000, server.fetchImpl)).toBe(true);
    expect(log.readOnly).toBe(false);
  });

  it('on another device that switched it, writes back no v3 row and keeps its own edit', async () => {
    const server = await edge(v3(), { wireMin: 3 });
    const storage = memoryStorage();
    const other = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage, null))!;
    const switcher = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(await switchLibraryToV4(switcher, Date.now(), server.fetchImpl)).toBe(true);

    // An edit made before this browser learns of the switch is refused by the fence's successor, and kept.
    server.log.refuseNext = 'generation_changed';
    const before = other.title({ type: 'movie', id: 550 })!;
    expect(
      await other.write({ ...before, dismissed: { value: true, at: at(9000) } }),
    ).not.toBeNull();
    await other.refresh();
    await other.refresh();

    expect(other.wireMinimum).toBe(4);
    const stored = await server.opened();
    expect(stored.filter((row) => ['rec', 'wat', 'snt', 'ep'].includes(row.kind))).toEqual([]);
    expect(document(stored, 'title:movie:550')).toMatchObject({
      reaction: { value: 'love' },
      dismissed: { value: true, at: at(9000) },
    });
    expect(other.pendingActions).toBe(0);
  });

  it('waits for a den-edge that takes minimum 4', async () => {
    const server = await edge(v3(), { wireMin: 3, version: '0.242.0' });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(await switchLibraryToV4(log, Date.now(), server.fetchImpl)).toBe(false);
    expect(server.log.commits).toEqual([]);
  });

  it('leaves a backup from before v3 as it is, and writes nothing to it', async () => {
    const episode = { ...markEpisode(blankEpisode({ type: 'tv', id: 1 }, 1, 1), true, at(1000)) };
    const server = await edge([episode], { wireMin: 3 });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(await switchLibraryToV4(log, Date.now(), server.fetchImpl)).toBe(false);
    expect(log.predatesV3).toBe(true);
    expect(libraryAlert(log)).toBe('Library backup predates v3');
    expect(server.log.commits).toEqual([]);
  });

  it('refuses rows of a newer format than this build: a minimum above 4', async () => {
    const server = await edge([filmDocument(550)], { wireMin: 5 });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(log.upgradeRequired).toBe(5);
    expect(log.needsV4).toBe(false);
    expect(await switchLibraryToV4(log, Date.now(), server.fetchImpl)).toBe(false);
  });
});

describe('SIMKL delivery on Library v4', () => {
  it('sends what is pending once, and keeps its receipt in a delivery document', async () => {
    const trackers: SettingsRow = {
      kind: 'set',
      schema: 2,
      name: 'trackers',
      values: {
        'simkl:42': { value: { string: JSON.stringify({ access_token: 'token' }) }, at: at(1000) },
      },
    };
    const deliver: SettingsRow = {
      kind: 'set',
      schema: 2,
      name: 'deliver:simkl:42',
      values: {
        since: { value: { string: JSON.stringify(at(500)) }, at: at(500) },
        lease: { value: { strings: ['', '1'] }, at: at(500) },
      },
    };
    const server = await edge([filmDocument(550), trackers, deliver]);
    let sends = 0;
    const connection: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/config') return new Response(JSON.stringify({ simklClientId: 'client' }));
      if (url.includes('/sync/all-items'))
        return new Response(JSON.stringify({ movies: [], shows: [] }));
      if (url.includes('api.simkl.com') && init?.method === 'POST') {
        sends++;
        return new Response('{}');
      }
      return server.fetchImpl(input, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
    expect(await deliverSimkl(log, DEVICE, connection, 600_000)).toBe(true);
    expect(sends).toBe(1);
    const receipts = (await server.opened()).find((row) => row.kind === 'delivery') as DocumentRow;
    expect(receipts).toMatchObject({
      provider: 'simkl',
      account: '42',
      title: { type: 'movie', id: 550 },
    });
    expect((receipts.entries as Record<string, unknown[]>).list?.[0]).toBe('in');
    expect(await deliverSimkl(log, DEVICE, connection, 600_000)).toBe(true);
    expect(sends).toBe(1);
  });
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  } as Storage;
}
