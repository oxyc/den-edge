import { describe, expect, it } from 'vitest';
import { applyLog, continueWatching, untitled, watchlist, withDisplay, type Library } from './library';
import { readLog } from './log';
import { fetchTitle, storedTmdbKey } from './tmdb';
import { deriveKeys, seal, type EpisodeRow, type Stamp, type TitleRow } from './wire';

const LIBRARY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const at = (t: number): Stamp => [t, 0, 'tv01'];

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

/** den-edge's `changes`, paged by `limit`, over rows sealed like the TV seals them. */
async function edge(rows: TitleRow[], extra: { k: string; v: string }[] = []): Promise<typeof fetch> {
  const keys = await deriveKeys(Uint8Array.from(atob(LIBRARY_KEY), (c) => c.charCodeAt(0)));
  const sealed = [...(await Promise.all(rows.map((r) => seal(keys, r)))), ...extra].map((e, i) => ({ ...e, seq: i + 1 }));
  return async (input, init) => {
    const url = new URL(String(input), 'https://den.example');
    if ((init?.headers as Record<string, string>)['x-den-library-token'] !== keys.token) {
      return new Response('{"error":"forbidden"}', { status: 403 });
    }
    const since = Number(url.searchParams.get('since'));
    const newer = sealed.filter((e) => e.seq > since);
    const page = newer.slice(0, 2); // a small page, so paging is exercised
    return new Response(JSON.stringify({ entries: page, head: sealed.length, more: newer.length > 2 }), { status: 200 });
  };
}

describe('readLog', () => {
  it('reads every page and opens each row, skipping one that does not open', async () => {
    const rows = [row(1), row(2), row(3)];
    const rows2 = await readLog(LIBRARY_KEY, await edge(rows, [{ k: 'ab'.repeat(32), v: 'AAAA' }]));
    expect(rows2).toEqual(rows);
  });

  it('is empty for a library nobody wrote, and null when den-edge is out of reach', async () => {
    expect(await readLog(LIBRARY_KEY, async () => new Response('{}', { status: 404 }))).toEqual([]);
    expect(await readLog(LIBRARY_KEY, async () => Promise.reject(new TypeError('offline')))).toBeNull();
    expect(await readLog(LIBRARY_KEY, async () => new Response('{}', { status: 500 }))).toBeNull();
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
