import { expect, test } from 'vitest';
import type { Library } from './library';
import { selectHomeLibraryView } from './homeLibraryView';
import type { TitleRow } from './wire';

const COUNT = 5_000;
const rows: TitleRow[] = Array.from({ length: COUNT }, (_, id) => ({
  kind: 'rec',
  schema: 2,
  title: { type: id % 2 ? 'movie' : 'tv', id },
  status: { value: id % 3 === 0 ? 'watched' : 'watchlist', at: [id, 0, 'bench'] },
  resume: { value: 0, at: [id, 0, 'bench'], viewing: 0 },
  reaction: { value: id % 11 === 0 ? 'like' : null, at: [id, 0, 'bench'] },
  deleted: { value: false, at: [0, 0, ''] },
  dismissed: { value: false, at: [0, 0, ''] },
  episodesReset: null,
  addedAt: id,
  watchedAt: id % 3 === 0 ? id : null,
}));
const library: Library = {
  records: rows.map((row) => ({
    title: { ...row.title, title: '' },
    status: row.status.value,
    progress: 0,
    progressAt: row.resume.at[0],
    addedAt: row.addedAt,
    deleted: false,
  })),
  marks: [],
  flags: new Map(),
  shapes: new Map(),
  dismissed: new Map(),
};
const view = selectHomeLibraryView(library, rows);

test('Home worker reply payload (5,000 titles)', async ({ bench }) => {
  const graph = bench('current projection graph clone', () => structuredClone({ rows, library }));
  const compact = bench('compact Home view clone', () => structuredClone(view));
  const results = await bench.compare(graph, compact);
  expect(results.get('compact Home view clone')).toBeFasterThan(
    results.get('current projection graph clone'),
  );
});
