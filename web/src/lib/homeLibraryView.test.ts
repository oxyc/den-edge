import { expect, it } from 'vitest';
import type { Library } from './library';
import { digestHomeLibraryView, selectHomeLibraryView } from './homeLibraryView';
import type { TitleRow } from './wire';

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

it('selects the fixed Home view from rows once', () => {
  const rows: TitleRow[] = [
    titleRow(1, 'watched', 'love', 10),
    titleRow(2, 'watchlist', null, 20),
    titleRow(3, 'inProgress', 'dislike', 30),
    titleRow(4, 'watched', null, 40, true),
  ];
  const library = foldFor(rows);
  const worker = selectHomeLibraryView(library, rows);
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
  expect(digestHomeLibraryView(worker)).toMatchObject({ hash: expect.any(String) });
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
