import { expect, it } from 'vitest';
import type { Title } from './library';
import type { LibraryOverviewView, Standing, TitleRef } from './libraryServiceProtocol';
import { OverviewTitleIndex, titleViewRows } from './libraryViewPresentation';
import { titleState } from './titleState';

const ref = (id: number): TitleRef => ({ type: id % 2 === 0 ? 'tv' : 'movie', id });
const title = (id: number): Title => ({ ...ref(id), title: `Title ${id}` });
const standings: readonly [Standing, Standing, Standing] = ['watchlist', 'in-progress', 'watched'];

function overview(size: number): LibraryOverviewView {
  const owned = Array.from({ length: size }, (_, index) => ref(index));
  const watched = owned.filter(({ id }) => id % 5 === 0);
  const titleStandings = owned.map(({ type, id }, index) => ({
    title: { type, id },
    standing: standings[index % standings.length]!,
  }));
  return {
    kind: 'overview',
    owned,
    watched,
    watchlist: [],
    standings: titleStandings,
    weighted: [],
    seeds: { watched: [], watchlisted: [] },
  };
}

it('presents correct title state from a large overview replacement', () => {
  const first = new OverviewTitleIndex(overview(20_000));

  expect(first.row(title(19_999))).toMatchObject({
    deleted: { value: false },
    status: { value: 'inProgress' },
  });
  expect(first.row(title(19_995))).toMatchObject({
    deleted: { value: false },
    status: { value: 'watched' },
  });
  expect(first.row(title(20_001))).toBeUndefined();

  const replacement = overview(3);
  replacement.owned = [ref(20_001)];
  replacement.watched = [ref(20_001)];
  replacement.standings = [];
  const second = new OverviewTitleIndex(replacement);

  expect(second.row(title(19_999))).toBeUndefined();
  expect(second.row(title(20_001))).toMatchObject({
    deleted: { value: false },
    status: { value: 'watched' },
  });
});

it('keeps a reaction on a series that is not on the watchlist', () => {
  const { row } = titleViewRows(title(2), {
    kind: 'title',
    title: ref(2),
    listed: false,
    watched: false,
    reaction: 'love',
    standing: null,
    progress: null,
    episodes: [],
  });

  expect(titleState(row).reaction).toBe('love');
});

it('preserves the presentation meaning of each overview membership', () => {
  const snapshot = overview(0);
  snapshot.owned = [ref(1)];
  snapshot.watched = [ref(5)];
  snapshot.standings = [{ title: ref(2), standing: 'in-progress' }];
  const rows = new OverviewTitleIndex(snapshot);

  expect(rows.row(title(1))).toMatchObject({
    deleted: { value: false },
    status: { value: 'none' },
  });
  expect(rows.row(title(5))).toMatchObject({
    deleted: { value: true },
    status: { value: 'watched' },
  });
  expect(rows.row(title(2))).toMatchObject({
    deleted: { value: true },
    status: { value: 'inProgress' },
  });
  expect(rows.row(title(3))).toBeUndefined();
});
