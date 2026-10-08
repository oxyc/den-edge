import { expect, it } from 'vitest';
import { standings, titleKey, type Library } from './library';
import {
  digestHomeLibraryView,
  homeLibraryViewFromCurrent,
  selectHomeLibraryView,
} from './homeLibraryView';
import { personalSeedRows } from './libraryNaming';
import type { Row, TitleRow } from './wire';

const titleRow = (
  id: number,
  status: TitleRow['status']['value'],
  reaction: TitleRow['reaction']['value'],
  at: number,
  deleted = false,
): TitleRow => ({
  kind: 'rec',
  schema: 2,
  title: { type: id % 2 ? 'movie' : 'tv', id },
  status: { value: status, at: [at, 0, 'test'] },
  resume: { value: status === 'inProgress' ? 0.4 : 0, at: [at, 0, 'test'], viewing: 0 },
  reaction: { value: reaction, at: [at + 1, 0, 'test'] },
  deleted: { value: deleted, at: [at, 0, 'test'] },
  dismissed: { value: false, at: [0, 0, ''] },
  episodesReset: null,
  addedAt: at - 2,
  watchedAt: status === 'watched' ? at : null,
});

function foldFor(rows: TitleRow[]): Library {
  return {
    records: rows.map((row) => ({
      title: { ...row.title, title: '' },
      status: row.status.value,
      progress: row.resume.value,
      progressAt: row.resume.at[0],
      addedAt: row.addedAt,
      deleted: row.deleted.value,
    })),
    marks: [
      {
        type: 'tv',
        id: 8,
        season: 1,
        episode: 2,
        fraction: 0.3,
        updatedAt: 90,
        title: '',
        voteAverage: 0,
      },
    ],
    flags: new Map(),
    shapes: new Map(),
    dismissed: new Map(),
  };
}

it('matches the fixed inputs Home currently derives on the page thread', () => {
  const rows: Row[] = [
    titleRow(1, 'watched', 'love', 10),
    titleRow(2, 'watchlist', null, 20),
    titleRow(3, 'inProgress', 'dislike', 30),
    titleRow(4, 'watched', null, 40, true),
  ];
  const library = foldFor(rows as TitleRow[]);
  const titleRows = rows.filter((row): row is TitleRow => row.kind === 'rec' && !row.deleted.value);
  const reactions = new Map(titleRows.map((row) => [titleKey(row.title), row.reaction.value]));
  const selected = personalSeedRows(titleRows);
  const watched = new Set(
    library.records
      .filter((record) => !record.deleted && record.status === 'watched')
      .map((record) => titleKey(record.title)),
  );
  const weighted = library.records.flatMap((record) => {
    if (record.deleted) return [];
    const reaction = reactions.get(titleKey(record.title));
    const weight =
      reaction === 'dislike'
        ? -1.5
        : (record.status === 'watched' || record.status === 'inProgress'
            ? 1
            : record.status === 'watchlist'
              ? 0.6
              : 0) + (reaction === 'love' ? 1 : reaction === 'like' ? 0.5 : 0);
    return weight === 0
      ? []
      : [
          {
            ref: { type: record.title.type, id: record.title.id },
            weight,
            at: Math.max(record.progressAt, record.addedAt),
          },
        ];
  });

  const worker = selectHomeLibraryView(library, rows);
  const current = homeLibraryViewFromCurrent({
    library,
    rows,
    titleRows,
    reactions,
    selected,
    watched,
    watchlist: library.records
      .filter((record) => !record.deleted && record.status === 'watchlist')
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((record) => titleKey(record.title)),
    standings: standings(library),
    weighted,
  });

  expect(worker).toEqual(current);
  expect(worker).toMatchObject({
    owned: ['movie:1', 'tv:2', 'movie:3'],
    watched: ['movie:1'],
    watchlist: ['tv:2'],
    standings: [
      ['tv:8', 'inProgress'],
      ['movie:1', 'watched'],
      ['tv:2', 'watchlist'],
      ['movie:3', 'inProgress'],
    ],
    weighted: [
      ['movie:1', 2, 10],
      ['tv:2', 0.6, 20],
      ['movie:3', -1.5, 30],
    ],
    seeds: { watched: ['movie:1'], watchlisted: ['tv:2'] },
  });
  expect(digestHomeLibraryView(worker)).toEqual(digestHomeLibraryView(current));
  expect(worker).not.toHaveProperty('continue');
});

it('is materially smaller than the representative projection graph it describes', () => {
  const rows = Array.from({ length: 5_000 }, (_, id) =>
    titleRow(
      id,
      id % 3 === 0 ? 'watched' : id % 3 === 1 ? 'watchlist' : 'inProgress',
      id % 11 === 0 ? 'like' : null,
      id + 100,
    ),
  );
  const library = foldFor(rows);
  const graphBytes = new TextEncoder().encode(JSON.stringify({ rows, library })).byteLength;
  const proof = selectHomeLibraryView(library, rows);
  const proofBytes = digestHomeLibraryView(proof).bytes;

  expect(proofBytes).toBeLessThan(graphBytes / 4);
});
