import { describe, expect, it, vi } from 'vitest';
import {
  addToWatchlist,
  blankEpisode,
  blankTitle,
  markEpisode,
  markWatched,
  react,
  updateEpisodeProgress,
} from './actions';
import { libraryAlert } from './librarySession.svelte';
import { switchLibraryToV4 } from './libraryUpgrade';
import { applyOps, opsFor } from './libraryV4';
import type { Vault } from './localVault';
import { LibraryLog } from './log';
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
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect([...log.unreadable.values()]).toEqual(['open']);
    expect(await log.compact()).toBe(true);
    expect(server.stored.has(bad.k)).toBe(false);
    expect(server.stored.size).toBe(2);
    expect(log.unreadable.size).toBe(0);
    expect(server.log.commits).toEqual([{ base: 3, wireMin: 4 }]);
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
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(log.unreadable.size).toBe(11);
    expect(await log.compact()).toBe(false);
    expect(server.log.commits).toEqual([]);
    expect(server.stored.size).toBe(13);
    expect(libraryAlert(log)).toBe('Delivery paused: library rows can’t be read');
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

  it('keeps episode progress written on v3 while the fence is held, through the commit', async () => {
    const server = await edge(v3(), { wireMin: 3 });
    const player = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, memoryStorage(), null))!;
    const switcher = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    // What a write gets while another device holds the switch's fence: refused for now, and kept (as a `wat` row).
    server.log.refuseNext = 'rewrite_in_progress';
    const ref = { type: 'tv' as const, id: 1399 };
    const before = player.episode(ref, 1, 5) ?? blankEpisode(ref, 1, 5);
    expect(await player.write(updateEpisodeProgress(before, 0.4, 500, at(9000)))).not.toBeNull();
    expect(player.pendingActions).toBe(1);
    expect(await switchLibraryToV4(switcher, Date.now(), server.fetchImpl)).toBe(true);

    await player.refresh();
    await player.refresh();
    const season = document(await server.opened(), 'season:tv:1399:1')!;
    const episodes = season.episodes as Record<string, { progress?: unknown }>;
    expect(episodes['5']?.progress).toMatchObject({ value: 0.4, seconds: 500 });
    expect(episodes['2']?.progress).toMatchObject({ value: 1 });
    expect(player.episode(ref, 1, 5)?.progress).toMatchObject({ value: 0.4, seconds: 500 });
    expect(player.pendingActions).toBe(0);
  });

  it('lifts a failed switch here once another device commits it', async () => {
    const server = await edge(v3(), { wireMin: 3 });
    const failing = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dryRun.fail = true;
    try {
      expect(await switchLibraryToV4(failing, Date.now(), server.fetchImpl)).toBe(false);
    } finally {
      dryRun.fail = false;
      error.mockRestore();
    }
    expect(failing.readOnly).toBe(true);
    const switcher = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(await switchLibraryToV4(switcher, Date.now(), server.fetchImpl)).toBe(true);

    await failing.refresh();
    expect(failing.readOnly).toBe(false);
    expect(libraryAlert(failing)).toBeNull();
    const film = failing.title({ type: 'movie', id: 550 })!;
    expect(await failing.write(react(film, 'like', at(9500)))).not.toBeNull();
    expect(document(await server.opened(), 'title:movie:550')?.reaction).toEqual({
      value: 'like',
      at: at(9500),
    });
  });

  it('gives den-core an episode row of a film as the TV does, so it is not staged into the v4 log', async () => {
    const stray = markEpisode(blankEpisode({ type: 'movie', id: 550 }, 1, 1), true, at(1200));
    const server = await edge([...v3(), stray], { wireMin: 3 });
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    expect(await switchLibraryToV4(log, Date.now(), server.fetchImpl)).toBe(true);
    // Two titles, a season and the settings row: the stray row is dropped, not kept for a second switch.
    expect(server.stored.size).toBe(4);
    expect(log.needsV4).toBe(false);
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
    expect(await watched(log, connection)).toBe(true);
    expect(leaseOf(await server.opened())).toEqual({ strings: [DEVICE, '8'] });
  });

  it('takes the lease compare-and-set: another device that renewed it since keeps it', async () => {
    const { server, connection, sent } = await simkl([
      filmDocument(550),
      trackers,
      deliver(['', '1']),
    ]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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

  it('a browser kept at v3 and an old generation takes the switch another device made', async () => {
    // A library larger than this browser's storage has room for twice over: every title, and SIMKL connected.
    const titles = Array.from({ length: 40 }, (_, i) => rec('movie', 1000 + i));
    const { server, connection } = await simkl(
      [rec('movie', 550), ...titles, watch, prefs, trackers, deliver(['', '1'])],
      { wireMin: 3 },
    );
    const vault = memoryVault();
    const storage = memoryStorage(8_000);

    // A visit while the library was v3: it is kept here, and an edit den-edge refused for now is kept with it.
    const visit = (await LibraryLog.open(LIBRARY_KEY, connection, storage, vault.vault))!;
    await vi.waitFor(() => expect(vault.data.size).toBe(1));
    server.log.refuseNext = 'rewrite_in_progress';
    const film = visit.title({ type: 'movie', id: 550 })!;
    expect(await visit.write({ ...film, dismissed: { value: true, at: at(9000) } })).not.toBeNull();
    expect(visit.pendingActions).toBe(1);

    // The TV switches it to v4: minimum 4, a new generation.
    const tv = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, undefined, null))!;
    // Its dry run lists the rating commands v4 no longer sends for titles nobody rated.
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await switchLibraryToV4(tv, Date.now(), server.fetchImpl)).toBe(true);
    quiet.mockRestore();
    const generations = server.log.commits.length;

    // The next load, as `LibrarySession.refresh` runs it.
    const asked: { method: string; action: string; status: number }[] = [];
    const recording: typeof fetch = async (input, init) => {
      const res = await connection(input, init);
      const action = new URL(String(input), 'https://den.example').pathname.split('/')[3] ?? '';
      if (String(input).startsWith('/lib/'))
        asked.push({ method: init?.method ?? 'GET', action, status: res.status });
      return res;
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, recording, storage, vault.vault))!;
    expect(log.fromCache).toBe(true);
    await log.refresh();
    await switchLibraryToV4(log, Date.now(), recording);
    await watched(log, recording);

    expect(asked.filter(({ action }) => action === 'rewrite')).toEqual([]);
    expect(server.log.commits).toHaveLength(generations);
    // At most one refusal, by which it learns the new generation.
    expect(asked.filter(({ status }) => status === 409).slice(1)).toEqual([]);
    const writes = asked.filter(({ action }) => action === 'batch');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.status).toBe(200);
    expect(log.wireMinimum).toBe(4);
    expect(log.needsV4).toBe(false);
    expect(libraryAlert(log)).toBeNull();
    // The kept edit, written back as v4 writes; the lease taken under the current generation.
    const stored = await server.opened();
    expect(document(stored, 'title:movie:550')?.dismissed).toEqual({ value: true, at: at(9000) });
    expect(stored.filter((row) => ['rec', 'wat', 'ep'].includes(row.kind))).toEqual([]);
    const lease = stored.find(
      (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
    )!.values.lease?.value;
    expect(lease).toEqual({ strings: [DEVICE, expect.any(String)] });
    expect(log.pendingActions).toBe(0);

    // Written back once: the next refresh sends nothing.
    asked.length = 0;
    await log.refresh();
    expect(asked.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  it('a lease refused by a generation change reads the new log, and a later pass takes it', async () => {
    const { server, connection } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
      const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, listing, undefined, null))!;
    expect(await watched(log, listing)).toBe(true);
    const latch = (await server.opened()).find(
      (row): row is SettingsRow => row.kind === 'set' && row.name === 'deliver:simkl:42',
    )!.values.removals?.value as { string: string };
    expect(Object.keys(JSON.parse(latch.string) as object).sort()).toEqual(['approved', 'held']);

    failing = false;
    await log.refresh();
    expect(await deliverSimkl(log, DEVICE, listing, 600_000)).toBe(true);
    expect(sent.count).toBe(21);
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
    const log = (await LibraryLog.open(LIBRARY_KEY, listing, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
      const log = (await LibraryLog.open(LIBRARY_KEY, slow, undefined, null))!;
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
      const log = (await LibraryLog.open(LIBRARY_KEY, stepping, undefined, null))!;
      expect(await watched(log, stepping)).toBe(true);
      expect(sent.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('watches on the lesser of its clocks: a wall clock that jumps ahead is no ten minutes', async () => {
    const { connection, sent } = await simkl([filmDocument(550), trackers, deliver(['', '1'])]);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
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
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, undefined, null))!;
    expect(await watched(log, connection)).toBe(true);
    expect(sent.count).toBe(1);
  });
});

function memoryVault() {
  const data = new Map<string, Uint8Array>();
  const vault: Vault = {
    get: async (k) => data.get(k),
    put: async (k, value) => void data.set(k, value),
    remove: async (prefix) => {
      for (const k of [...data.keys()]) if (k.startsWith(prefix)) data.delete(k);
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
