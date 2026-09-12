import { describe, expect, it } from 'vitest';
import { addToWatchlist, blankTitle, react } from './actions';
import { applyLog, continueWatching, untitled, watchlist, withDisplay, type Library } from './library';
import { LibraryLog } from './log';
import { recordTrackerEvent } from './trackerEvents';
import { fetchDetails } from './tmdb';
import { deriveKeys, seal, type EpisodeRow, type Row, type Stamp, type TitleRow } from './wire';

const LIBRARY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const at = (t: number, device = 'tv01'): Stamp => [t, 0, device];

function row(id: number, overrides: Partial<TitleRow> = {}): TitleRow {
  return {
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id },
    status: { value: 'watchlist', at: at(1000) },
    resume: { value: 0, at: at(1000), viewing: 0 },
    reaction: { value: null, at: at(1000) },
    deleted: { value: false, at: at(1000) },
    dismissed: { value: false, at: at(1000) },
    episodesReset: null,
    addedAt: 1000,
    watchedAt: null,
    ...overrides,
  };
}

/**
 * den-edge's `/lib` in memory, with library.rs's rules: `changes` paged in sequence order (two a page, so paging
 * is exercised), and `batch` with compare-and-set on each row's sequence.
 */
async function edge(rows: Row[] = [], extra: { k: string; v: string }[] = []) {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  let head = 0;
  const stored = new Map<string, { k: string; seq: number; v: string }>();
  for (const entry of [...(await Promise.all(rows.map((r) => seal(keys, r)))), ...extra]) {
    stored.set(entry.k, { ...entry, seq: ++head });
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    if ((init?.headers as Record<string, string>)['x-den-library-token'] !== keys.token) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    if (init?.method === 'POST') {
      const { writes } = JSON.parse(String(init.body)) as { writes: { k: string; base: number; v: string }[] };
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
      return new Response(JSON.stringify({ head, applied, conflicts }), { status: 200 });
    }
    const since = Number(new URL(String(input), 'https://den.example').searchParams.get('since'));
    const newer = [...stored.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
    return new Response(JSON.stringify({ entries: newer.slice(0, 2), head, more: newer.length > 2 }), { status: 200 });
  };
  return { fetchImpl, stored };
}

describe('LibraryLog', () => {
  it('a second relay reset cannot overwrite unfinished recovery from the first', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); }, clear: () => data.clear(),
    };
    let server = await edge();
    let writesAllowed = Infinity;
    const connection: typeof fetch = (url, init) => {
      if (init?.method === 'POST' && writesAllowed-- <= 0) return Promise.resolve(new Response('{}', { status: 503 }));
      if (init?.method !== 'POST' && !server.stored.size) return Promise.resolve(new Response('{}', { status: 404 }));
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const journals = Array.from({ length: 40 }, (_, i) => {
      const before = blankTitle({ type: 'movie', id: i + 1 }, 0);
      return recordTrackerEvent(before, addToWatchlist(before, at(1000)), at(1000), 'recovery-' + i)!;
    });
    await log.writeActions(journals);
    server = await edge(); writesAllowed = 1;
    await log.refresh(); // Only the first 32 journals recover.
    server = await edge(); writesAllowed = 0;
    await log.refresh(); // Must retain the first checkpoint, including the unfinished remainder.
    writesAllowed = Infinity;
    const reopened = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(reopened.pendingActions).toBe(0);
    expect(reopened.title({ type: 'movie', id: 40 })?.status.value).toBe('watchlist');
    expect(reopened.settings('tracker-event:recovery-39')).toBeDefined();
  });

  it('republishes acknowledged actions after the relay is restored empty', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); }, clear: () => data.clear(),
    };
    let server = await edge();
    let generation = 'original';
    const connection: typeof fetch = async (url, init) => {
      if (init?.method !== 'POST' && server.stored.size === 0) return new Response(JSON.stringify({ generation }), { status: 404 });
      const res = await server.fetchImpl(url, init);
      return new Response(JSON.stringify({ ...await res.json(), generation }), { status: res.status });
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const before = blankTitle({ type: 'movie', id: 10 }, 0);
    await log.writeAction(recordTrackerEvent(before, addToWatchlist(before, at(1000)), at(1000), 'accepted')!);
    expect(log.pendingActions).toBe(0);
    server = await edge();
    generation = 'restored';
    expect(await log.refresh()).toBe(true);
    expect(log.pendingActions).toBe(0);
    const reopened = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(reopened.title(before.title)?.status.value).toBe('watchlist');
    expect(reopened.settings('tracker-event:accepted')).toBeDefined();
  });

  it('persists a complete bulk action before delivery and retries it in bounded batches', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); }, clear: () => data.clear(),
    };
    const server = await edge();
    let offline = false;
    const sizes: number[] = [];
    const connection: typeof fetch = (url, init) => {
      if (offline) return Promise.reject(new TypeError('offline'));
      if (init?.method === 'POST') sizes.push(JSON.parse(String(init.body)).writes.length);
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const journals = Array.from({ length: 65 }, (_, i) => {
      const before = blankTitle({ type: 'movie', id: i + 1 }, 0);
      return recordTrackerEvent(before, addToWatchlist(before, at(1000)), at(1000), 'bulk-' + i)!;
    });
    offline = true;
    expect(await log.writeActions(journals)).toBe(true);
    expect(data.size).toBe(1);
    expect(log.title({ type: 'movie', id: 65 })?.status.value).toBe('watchlist');
    offline = false;
    const restored = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(restored.pendingActions).toBe(0);
    expect(restored.title({ type: 'movie', id: 65 })?.status.value).toBe('watchlist');
    expect(sizes).toEqual([32, 32, 1, 32, 32, 1]);
  });

  it('retries the first offline action when an empty relay still answers 404', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); }, clear: () => data.clear(),
    };
    const server = await edge();
    let offline = false;
    const connection: typeof fetch = (url, init) => {
      if (offline) return Promise.reject(new TypeError('offline'));
      if (init?.method !== 'POST' && server.stored.size === 0) return Promise.resolve(new Response('{}', { status: 404 }));
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    offline = true;
    await log.writeAction(recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'first')!);
    offline = false;
    expect(await log.refresh()).toBe(true);
    expect(log.pendingActions).toBe(0);
    expect((await LibraryLog.open(LIBRARY_KEY, connection))!.title(blank.title)?.status.value).toBe('watchlist');
  });

  it('skips an unreadable incremental row and still reaches later changes', async () => {
    const server = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    server.stored.set('bad', { k: 'ab'.repeat(32), seq: 1, v: 'AAAA' });
    const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
    const good = await seal(keys, row(11));
    server.stored.set(good.k, { ...good, seq: 2 });
    expect(await log.refresh()).toBe(true);
    expect(log.title({ type: 'movie', id: 11 })?.status.value).toBe('watchlist');
  });

  it('a failed pending cleanup does not reject an accepted action', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); },
      removeItem: () => { throw new Error('storage denied'); }, clear: () => data.clear(),
    };
    const server = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl, storage))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    expect(await log.writeAction(recordTrackerEvent(blank, addToWatchlist(blank, at(1000)), at(1000), 'cleanup')!)).not.toBeNull();
    expect(log.title(blank.title)?.status.value).toBe('watchlist');
    expect(log.pendingActions).toBe(1);
  });

  it('serializes concurrent same-row saves without losing either field', async () => {
    const { fetchImpl } = await edge();
    const log = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    await Promise.all([
      log.write(addToWatchlist(blank, at(1000, 'web'))),
      log.write(react(blank, 'love', at(2000, 'web'))),
    ]);
    const restored = (await LibraryLog.open(LIBRARY_KEY, fetchImpl))!.title(blank.title)!;
    expect(restored.status.value).toBe('watchlist');
    expect(restored.reaction.value).toBe('love');
  });

  it('reconstructs state from an accepted journal if the following projection write fails', async () => {
    const server = await edge();
    let writes = 0;
    const flaky: typeof fetch = (url, init) => {
      if (init?.method === 'POST' && ++writes === 2) return Promise.resolve(new Response('{}', { status: 503 }));
      return server.fetchImpl(url, init);
    };
    const log = (await LibraryLog.open(LIBRARY_KEY, flaky))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const event = recordTrackerEvent(blank, addToWatchlist(blank, at(1000, 'web')), at(1000, 'web'), 'crash')!;
    expect(await log.writeAction(event)).not.toBeNull();
    const restored = (await LibraryLog.open(LIBRARY_KEY, server.fetchImpl))!;
    expect(restored.title(blank.title)?.status.value).toBe('watchlist');
  });

  it('persists encrypted offline actions, then retries them after reopening', async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); },
      removeItem: (k) => { data.delete(k); }, clear: () => data.clear(),
    };
    const server = await edge();
    let offline = false;
    const connection: typeof fetch = (url, init) => offline ? Promise.reject(new TypeError('offline')) : server.fetchImpl(url, init);
    const log = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    const blank = blankTitle({ type: 'movie', id: 10 }, 0);
    const event = recordTrackerEvent(blank, addToWatchlist(blank, at(1000, 'web')), at(1000, 'web'), 'offline')!;
    offline = true;
    expect(await log.writeAction(event)).not.toBeNull();
    expect(log.pendingActions).toBe(1);
    expect([...data.values()].join('')).not.toContain('watchlist');
    offline = false;
    const restored = (await LibraryLog.open(LIBRARY_KEY, connection, storage))!;
    expect(restored.pendingActions).toBe(0);
    expect(restored.title(blank.title)?.status.value).toBe('watchlist');
  });
  it('reads every page and opens each row, skipping one that does not open', async () => {
    const rows = [row(1), row(2), row(3)];
    const { fetchImpl } = await edge(rows, [{ k: 'ab'.repeat(32), v: 'AAAA' }]);
    expect((await LibraryLog.open(LIBRARY_KEY, fetchImpl))?.rows()).toEqual(rows);
  });

  it('is empty for a library nobody wrote, and null when den-edge is out of reach', async () => {
    expect((await LibraryLog.open(LIBRARY_KEY, async () => new Response('{}', { status: 404 })))?.rows()).toEqual([]);
    expect(await LibraryLog.open(LIBRARY_KEY, async () => Promise.reject(new TypeError('offline')))).toBeNull();
    expect(await LibraryLog.open(LIBRARY_KEY, async () => new Response('{}', { status: 500 }))).toBeNull();
  });

  it('says when the TV moved the library to a new key', async () => {
    const gone: typeof fetch = async () => new Response('{"error":"library_moved"}', { status: 410 });
    const opened = await LibraryLog.open(LIBRARY_KEY, gone);
    expect([opened?.moved, opened?.rows()]).toEqual([true, []]);

    const { fetchImpl } = await edge();
    const log = await LibraryLog.open(LIBRARY_KEY, async (input, init) =>
      init?.method === 'POST' ? gone(input, init) : fetchImpl(input, init),
    );
    expect(log?.moved).toBe(false);
    expect(await log!.write(addToWatchlist(blankTitle({ type: 'tv', id: 1 }, 0), at(1)))).toBeNull();
    expect(log?.moved).toBe(true);
  });

  it('knows the newest stamp it read', async () => {
    const { fetchImpl } = await edge([row(1), row(2, { reaction: { value: 'love', at: at(9000, 'web1') } })]);
    expect((await LibraryLog.open(LIBRARY_KEY, fetchImpl))?.newestStamp()).toEqual(at(9000, 'web1'));
  });

  it('writes a title new to the library, and a stale write merges on top of the row that beat it', async () => {
    const { fetchImpl } = await edge();
    const [phone, laptop] = [await LibraryLog.open(LIBRARY_KEY, fetchImpl), await LibraryLog.open(LIBRARY_KEY, fetchImpl)];
    const ref = { type: 'movie' as const, id: 438631 };

    // The phone adds it; the laptop, which read the log before that, reacts to it.
    expect(await phone!.write(addToWatchlist(blankTitle(ref, 5000), at(5000, 'ph01')))).not.toBeNull();
    const stored = await laptop!.write(react(blankTitle(ref, 6000), 'love', at(6000, 'lt01')));
    expect(stored?.kind === 'rec' && [stored.status.value, stored.reaction.value]).toEqual(['watchlist', 'love']);

    const reread = await LibraryLog.open(LIBRARY_KEY, fetchImpl);
    expect(reread?.title(ref)?.status.value).toBe('watchlist');
    expect(reread?.title(ref)?.reaction.value).toBe('love');
    expect(reread?.title(ref)?.addedAt).toBe(5000);
  });

  it('says so when a write cannot be saved', async () => {
    const { fetchImpl } = await edge();
    const log = await LibraryLog.open(LIBRARY_KEY, fetchImpl);
    const offline = await LibraryLog.open(LIBRARY_KEY, async (input, init) =>
      init?.method === 'POST' ? Promise.reject(new TypeError('offline')) : fetchImpl(input, init),
    );
    expect(log).not.toBeNull();
    expect(await offline!.write(addToWatchlist(blankTitle({ type: 'tv', id: 1 }, 0), at(1)))).toBeNull();
  });
});

describe('applyLog', () => {
  const backup: Library = {
    records: [
      {
        title: { type: 'movie', id: 1, title: 'Dune', posterPath: '/d.jpg' },
        status: 'watchlist',
        progress: 0,
        progressAt: 0,
        addedAt: 500,
        deleted: false,
      },
    ],
    marks: [],
    shapes: new Map(),
    dismissed: new Map(),
  };

  it("takes the log's state over the backup's and keeps the backup's display", () => {
    const library = applyLog(backup, [
      row(1, { status: { value: 'inProgress', at: at(2000) }, resume: { value: 0.4, at: at(2000), viewing: 0 } }),
    ]);
    expect(watchlist(library)).toEqual([]);
    expect(continueWatching(library)).toEqual([{ title: backup.records[0]!.title, fraction: 0.4 }]);
  });

  it('holds a title only the log knows until TMDB names it', () => {
    const library = applyLog(backup, [row(2, { addedAt: 3000 })]);
    expect(watchlist(library).map((t) => t.id)).toEqual([1]);
    expect(untitled(library)).toEqual([{ type: 'movie', id: 2 }]);
    const named = withDisplay(library, [{ type: 'movie', id: 2, title: 'Arrival' }]);
    expect(watchlist(named).map((t) => t.title)).toEqual(['Arrival', 'Dune']);
  });

  it('carries a dismissal from the log', () => {
    const dismissed = row(1, {
      status: { value: 'inProgress', at: at(2000) },
      resume: { value: 0.4, at: at(2000), viewing: 0 },
      dismissed: { value: true, at: at(2500) },
    });
    expect(continueWatching(applyLog(backup, [dismissed]))).toEqual([]);
  });

  const episode = (season: number, number: number, value: number, t: number): EpisodeRow => ({
    kind: 'ep',
    schema: 2,
    title: { type: 'tv', id: 95396 },
    season,
    episode: number,
    progress: { value, at: at(t), viewing: value === 0 ? 1 : 0 },
  });

  it('puts a series in Continue Watching from its episode rows, once it has a name', () => {
    const library = applyLog(backup, [episode(1, 2, 0.5, 4000)]);
    expect(untitled(library)).toEqual([{ type: 'tv', id: 95396 }]);
    const named = withDisplay(library, [{ type: 'tv', id: 95396, title: 'Severance', posterPath: '/s.jpg', rating: 8.4 }]);
    expect(continueWatching(named)[0]).toEqual({
      title: { type: 'tv', id: 95396, title: 'Severance', posterPath: '/s.jpg', rating: 8.4 },
      fraction: 0.5,
      episode: { season: 1, episode: 2 },
    });
  });

  it('drops an un-watched episode, and every episode from before a series reset', () => {
    const named = { ...backup, marks: [] };
    expect(applyLog(named, [episode(1, 2, 0.5, 4000), episode(1, 2, 0, 5000)]).marks).toEqual([]);
    const reset = row(95396, { title: { type: 'tv', id: 95396 }, episodesReset: at(4500) });
    const after = applyLog(named, [episode(1, 1, 1, 4000), episode(1, 2, 0.3, 5000), reset]);
    expect(after.marks.map((m) => m.episode)).toEqual([2]);
  });
});

describe('tmdb', () => {
  const answer = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 });

  it('names a movie and a series from their details', async () => {
    const movie = { title: 'Arrival', poster_path: '/a.jpg', release_date: '2016-11-11', vote_average: 7.6 };
    expect(await fetchDetails({ type: 'movie', id: 329865 }, 'k', answer(movie))).toEqual({
      title: {
        type: 'movie',
        id: 329865,
        title: 'Arrival',
        posterPath: '/a.jpg',
        year: 2016,
        releaseDate: '2016-11-11',
        rating: 7.6,
      },
    });
    const series = await fetchDetails({ type: 'tv', id: 95396 }, 'k', answer({ name: 'Severance', first_air_date: '2022-02-17' }));
    expect(series?.title).toMatchObject({ title: 'Severance', year: 2022 });
    expect(await fetchDetails({ type: 'tv', id: 1 }, 'k', async () => new Response('{}', { status: 401 }))).toBeNull();
  });

  it("reads a series' season layout, so Continue Watching can find the next episode", async () => {
    const severance = {
      name: 'Severance',
      seasons: [
        { season_number: 0, episode_count: 2 },
        { season_number: 1, episode_count: 9 },
        { season_number: 2, episode_count: 10 },
      ],
      last_episode_to_air: { season_number: 2, episode_number: 4 },
    };
    const found = await fetchDetails({ type: 'tv', id: 95396 }, 'k', answer(severance));
    expect(found?.shape).toEqual({
      counts: new Map([
        [0, 2],
        [1, 9],
        [2, 10],
      ]),
      lastAired: { season: 2, episode: 4 },
    });
  });
});
