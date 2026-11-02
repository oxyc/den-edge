import { beforeAll, describe, expect, test } from 'vitest';
import { LibraryColumns } from '../vendor/den-core/startup.js';
import { watchedHistory } from './history';
import { selectHomeLibraryView } from './homeLibraryView';
import { applyLog, emptyLibrary, type Title } from './library';
import { historyItemsFromColumns, homeFromColumns, newestFromColumns } from './libraryColumns';
import { household } from './libraryColumns.fixture';
import { projectDocument } from './libraryV4';
import { syncPolicy } from './syncCore';
import { ensureSyncPolicy } from './syncLoader';
import {
  compareStamps,
  newestSummary,
  rowName,
  ZERO_STAMP,
  type DocumentRow,
  type Row,
} from './wire';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const d = 'a1b2c3d4e5f60718';
const at = (t: number, device = d): [number, number, string] => [t, 0, device];

beforeAll(async () => ensureSyncPolicy());

/** Home, History and the newest stamp as the web derives them per document, through the full JS fold. */
function perDocument(documents: DocumentRow[], now = NOW) {
  const rows: Row[] = documents.flatMap((document) => projectDocument({ ...document }, now));
  const names = new Map<string, Title>();
  for (const { title } of documents)
    names.set(`${title.type}:${title.id}`, {
      ...title,
      title: `${title.type}:${title.id}`,
    } as Title);
  let stamp = ZERO_STAMP;
  let reconsiderAt = Infinity;
  for (const document of documents) {
    const summary = newestSummary({ ...document }, now);
    if (compareStamps(summary.stamp, stamp) > 0) stamp = summary.stamp;
    reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
    // A play more than a day ahead also counts once it is believed (den-edge#963); `newestSummary` reads stamps only.
    if (document.kind === 'season')
      for (const { plays } of Object.values(document.episodes as Record<string, { plays: object }>))
        for (const played of Object.values(plays) as number[])
          if (played > now + DAY) reconsiderAt = Math.min(reconsiderAt, played - DAY);
  }
  return {
    home: selectHomeLibraryView(applyLog(emptyLibrary(), rows), rows),
    history: watchedHistory(rows, names).map(({ title, at, episode, episodes }) => ({
      title: { type: title.type, id: title.id },
      watchedAt: at,
      ...(episode ? { episode } : {}),
      episodes,
    })),
    newest: { stamp, reconsiderAt },
  };
}

function lists(index: LibraryColumns, now = NOW) {
  return {
    home: homeFromColumns(index, now),
    history: historyItemsFromColumns(index, now),
    newest: newestFromColumns(index, now),
  };
}

function held(documents: DocumentRow[], now = NOW) {
  const index = new LibraryColumns();
  try {
    index.upsert(JSON.stringify(documents));
    return lists(index, now);
  } finally {
    index.free();
  }
}

const episode = (
  progress: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) => ({
  progress,
  imported: false,
  plays: {},
  cleared: null,
  ...extra,
});

/** Every reading Home and History make a decision on, one or two titles each. */
function varied(): DocumentRow[] {
  const future = NOW + 3 * DAY;
  return [
    // A film part-way through, on another device, with seconds and playing; one dismissed after it.
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 1 },
      status: { value: 'inProgress', at: at(NOW - 50) },
      resume: { value: 0.4, at: at(NOW - 50), viewing: 1, seconds: 1200, playing: false },
      reaction: { value: 'like', at: at(NOW - 40) },
      addedAt: NOW - 1000,
    },
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 2 },
      status: { value: 'inProgress', at: at(NOW - 60) },
      resume: { value: 0.2, at: at(NOW - 60), viewing: 0 },
      dismissed: { value: true, at: at(NOW - 10) },
      addedAt: NOW - 900,
    },
    // Watched films: one disliked, one deleted after it was watched, one imported at zero.
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 3 },
      status: { value: 'watched', at: at(NOW - 500) },
      reaction: { value: 'dislike', at: at(NOW - 400) },
      watchedAt: NOW - 600,
      addedAt: NOW - 800,
    },
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 4 },
      status: { value: 'watched', at: at(NOW - 500) },
      deleted: { value: true, at: at(NOW - 100) },
      addedAt: NOW - 800,
    },
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 5 },
      status: { value: 'watched', at: at(0, '') },
      addedAt: 0,
    },
    // Watchlisted: equal addedAt and equal seed recency (the key breaks the tie), a love reaction, and every
    // register stamped in the future.
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 6 },
      status: { value: 'watchlist', at: at(NOW - 300) },
      reaction: { value: 'love', at: at(NOW - 300) },
      addedAt: NOW - 300,
    },
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 60 },
      status: { value: 'watchlist', at: at(NOW - 300) },
      addedAt: NOW - 300,
    },
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 7 },
      status: { value: 'watchlist', at: at(NOW - 300) },
      addedAt: NOW - 300,
    },
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 8 },
      status: { value: 'inProgress', at: at(future) },
      resume: { value: 0.5, at: at(future), viewing: 0 },
      dismissed: { value: true, at: at(future) },
      addedAt: NOW - 50,
    },
    // A finished series listed again: it entered the library long ago, so only its status stamp says it is the newest.
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 16 },
      status: { value: 'watchlist', at: at(NOW - 20) },
      watchedAt: NOW - 6000,
      addedAt: NOW - 9500,
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 16 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 6000), viewing: 0 }, { plays: { 0: NOW - 6000 } }),
        2: episode({ value: 1, at: at(NOW - 6000), viewing: 0 }, { plays: { 0: NOW - 6000 } }),
      },
    },
    // A series being watched: finished episodes, then a later partial one; a Special.
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 10 },
      status: { value: 'watchlist', at: at(NOW - 5000) },
      addedAt: NOW - 5000,
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 10 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 3000), viewing: 0 }, { plays: { 0: NOW - 3000 } }),
        2: episode({ value: 1, at: at(NOW - 2000), viewing: 0 }, { plays: { 0: NOW - 2000 } }),
        10: episode({ value: 0.3, at: at(NOW - 400), viewing: 0, seconds: 300, playing: true }),
      },
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 10 },
      season: 0,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 500), viewing: 0 }, { plays: { 0: NOW - 500 } }),
      },
    },
    // A watched series reset after its first season: what came before no longer counts.
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 11 },
      status: { value: 'watched', at: at(NOW - 4000) },
      episodesReset: at(NOW - 2500),
      addedAt: NOW - 9000,
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 11 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 3000), viewing: 0 }, { plays: { 0: NOW - 3000 } }),
        2: episode(null, { imported: true, plays: { '-9007199254740991': 1 } }),
      },
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 11 },
      season: 2,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 2000), viewing: 0 }, { plays: { 0: NOW - 2000 } }),
        2: episode({ value: 1, at: at(NOW - 2000), viewing: 0 }, { plays: { 0: NOW - 2000 } }),
      },
    },
    // Known only by timeless imported bits, and by a season reset; a series with no title document.
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 12 },
      status: { value: 'none', at: at(0, '') },
      addedAt: NOW - 7000,
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 12 },
      season: 3,
      seasonReset: at(NOW - 100),
      episodes: {
        4: episode(null, { imported: true }),
        5: episode(null, { imported: true }),
      },
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 12 },
      season: 1,
      seasonReset: null,
      episodes: {
        7: episode(null, { imported: true }),
        8: episode({ value: 0, at: at(NOW - 20), viewing: 2 }),
      },
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 13 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 700), viewing: 0 }, { plays: { 0: NOW - 700 } }),
        2: episode({ value: 0.96, at: at(NOW - 700), viewing: 0 }),
      },
    },
    // A deleted series with a watch after its deletion, and a play more than a day ahead.
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id: 14 },
      status: { value: 'watched', at: at(NOW - 4000) },
      deleted: { value: true, at: at(NOW - 3500) },
      addedAt: NOW - 8000,
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 14 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: episode({ value: 1, at: at(NOW - 3000), viewing: 0 }, { plays: { 0: NOW - 3000 } }),
      },
    },
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 15 },
      season: 1,
      seasonReset: null,
      episodes: {
        1: episode(null, { plays: { 0: NOW + 4 * DAY } }),
      },
    },
  ] as DocumentRow[];
}

describe('library columns', () => {
  test('Home, History and the newest stamp equal the per-document projection', () => {
    const documents = varied();
    const expected = perDocument(documents);
    // The fixture reaches the branches it is meant to: a resume mark beside a finished one, a timeless flag, a kept
    // dismissal, a deleted title, a seed tie broken by key, a future play holding the reconsider time.
    const { continueLibrary } = expected.home;
    expect(continueLibrary.marks.some((m) => m.updatedBy === d)).toBe(true);
    expect(continueLibrary.flags!.size).toBeGreaterThan(0);
    expect([...continueLibrary.dismissed.keys()]).toContain('movie:2');
    expect(expected.history.some((e) => e.title.id === 4)).toBe(true);
    expect(expected.history.some((e) => e.title.id === 5 && e.watchedAt === 0)).toBe(true);
    expect(expected.home.seeds.watchlisted).toEqual(['movie:6', 'movie:60']);
    // The finished series listed again leads the watchlist, by when it was listed rather than its 9500-old `addedAt`.
    expect(expected.home.watchlist[0]).toBe('tv:16');
    expect(expected.newest.reconsiderAt).toBe(NOW + 2 * DAY);
    expect(held(documents)).toEqual(expected);
  });

  test('every list equals the projection once a future stamp is believed', () => {
    const documents = varied();
    for (const now of [NOW + 2 * DAY - 1, NOW + 2 * DAY, NOW + 3 * DAY, NOW + 5 * DAY])
      expect(held(documents, now)).toEqual(perDocument(documents, now));
  });

  test('every list equals the projection at household size (6,000 documents)', () => {
    const documents = household();
    const expected = perDocument(documents);
    expect(expected.history).toHaveLength(1_500);
    expect(held(documents)).toEqual(expected);
  }, 120_000);

  test('a replaced document moves its answer', () => {
    const documents = varied();
    const index = new LibraryColumns();
    try {
      index.upsert(JSON.stringify(documents));
      const edited = {
        ...documents[7]!,
        status: { value: 'watched', at: at(NOW - 1) },
      } as DocumentRow;
      index.upsert(JSON.stringify([edited]));
      expect(lists(index)).toEqual(
        perDocument(documents.map((doc, i) => (i === 7 ? edited : doc))),
      );
    } finally {
      index.free();
    }
  });

  test('document names equal den-core’s, and a malformed identity is still refused', () => {
    const named = varied().concat([
      {
        format: 4,
        kind: 'delivery',
        title: { type: 'tv', id: 10 },
        season: 1,
        provider: 'trakt',
        account: 'a_b-9',
      },
      {
        format: 4,
        kind: 'delivery',
        title: { type: 'movie', id: 1 },
        provider: 'simkl',
        account: 'x',
      },
    ] as DocumentRow[]);
    for (const document of named)
      expect(rowName(document)).toBe(syncPolicy<string>({ op: 'doc_name', document }));
    expect(named.map(rowName)).toContain('dlv:trakt:a_b-9:tv:10:1');
    for (const malformed of [
      { format: 4, kind: 'season', title: { type: 'tv', id: 1 } },
      { format: 4, kind: 'season', title: { type: 'movie', id: 1 }, season: 1 },
      { format: 4, kind: 'title', title: { type: 'tv', id: 0 } },
      { format: 4, kind: 'delivery', title: { type: 'tv', id: 1 }, provider: 'a:b', account: 'x' },
      { format: 4, kind: 'delivery', title: { type: 'tv', id: 1 }, provider: 'a', account: 'x y' },
    ] as DocumentRow[])
      expect(() => rowName(malformed)).toThrow();
  });
});
