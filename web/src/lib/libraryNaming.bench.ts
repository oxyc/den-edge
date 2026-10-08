import { expect, test } from 'vitest';
import { addToWatchlist, blankTitle, markWatched } from './actions';
import { personalSeedRows } from './libraryNaming';
import type { Row, TitleRow } from './wire';

const selectPersonalSeeds = personalSeedRows;
const titleKey = (title: { type: string; id: number }) => `${title.type}:${title.id}`;

const TITLES = 20_000;
const rows: Row[] = Array.from({ length: TITLES }, (_, id) =>
  id % 3 === 0
    ? addToWatchlist(blankTitle({ type: 'movie', id }, id % 997), [id % 991, 0, 'test'])
    : markWatched(blankTitle({ type: 'movie', id }, id % 997), [id % 991, 0, 'test']),
);

/** The pre-v0.264.10 selector, retained only as a benchmark control. */
function sortedPersonalSeedRows(source: Row[]) {
  const titles = source.filter((row): row is TitleRow => row.kind === 'rec' && !row.deleted.value);
  const recency = (row: TitleRow) => Math.max(row.watchedAt ?? 0, row.reaction.at[0], row.addedAt);
  const latest = (keep: (row: TitleRow) => boolean) =>
    titles
      .filter(keep)
      .sort((a, b) => recency(b) - recency(a) || titleKey(a.title).localeCompare(titleKey(b.title)))
      .slice(0, 2);
  return {
    watched: latest(
      (row) =>
        row.status.value === 'watched' ||
        row.reaction.value === 'like' ||
        row.reaction.value === 'love',
    ),
    watchlisted: latest((row) => row.status.value === 'watchlist'),
  };
}

test('personal recommendation seed selection (20,000 title rows)', async ({ bench }) => {
  const sorted = bench('whole-array sorts', () => sortedPersonalSeedRows(rows));
  const bounded = bench('bounded top-two selection', () => selectPersonalSeeds(rows));
  const results = await bench.compare(sorted, bounded);
  expect(results.get('bounded top-two selection')).toBeFasterThan(results.get('whole-array sorts'));
});
