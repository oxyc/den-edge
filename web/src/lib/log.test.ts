import { describe, expect, it } from 'vitest';
import { addToWatchlist, blankTitle, react } from './actions';
import { applyLog, continueWatching, untitled, watchlist, withDisplay, type Library } from './library';
import { LibraryLog } from './log';
import { fetchTitle, storedTmdbKey } from './tmdb';
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
  it('names a movie and a series from their details', async () => {
    const answer = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 });
    const movie = { title: 'Arrival', poster_path: '/a.jpg', release_date: '2016-11-11', vote_average: 7.6 };
    expect(await fetchTitle({ type: 'movie', id: 329865 }, 'k', answer(movie))).toEqual({
      type: 'movie',
      id: 329865,
      title: 'Arrival',
      posterPath: '/a.jpg',
      year: 2016,
      rating: 7.6,
    });
    const series = await fetchTitle({ type: 'tv', id: 95396 }, 'k', answer({ name: 'Severance', first_air_date: '2022-02-17' }));
    expect(series).toMatchObject({ title: 'Severance', year: 2022 });
    expect(await fetchTitle({ type: 'tv', id: 1 }, 'k', async () => new Response('{}', { status: 401 }))).toBeNull();
  });

  it("reads the companion page's key", () => {
    const storage = (value: string | null) => ({ getItem: () => value }) as unknown as Storage;
    expect(storedTmdbKey(storage(JSON.stringify({ tmdbKey: 'abc' })))).toBe('abc');
    expect(storedTmdbKey(storage('not json'))).toBe('');
    expect(storedTmdbKey(storage(null))).toBe('');
  });
});
