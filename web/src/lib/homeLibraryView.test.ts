import { expect, it, vi } from 'vitest';
import { applyLog, emptyLibrary, ContinueProjector, type Library } from './library';
import {
  continueItems,
  digestHomeLibraryView,
  projectHomeLibraryView,
  selectHomeLibraryView,
} from './homeLibraryView';
import { applyOps, projectDocument } from './libraryV4';
import { syncPolicy } from './syncCore';
import {
  isDocument,
  type DocumentRow,
  type EpisodeRow,
  type Row,
  type SettingsRow,
  type TitleRow,
} from './wire';

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
      ['movie:1', 'watched'],
      ['movie:3', 'inProgress'],
      ['tv:2', 'watchlist'],
      ['tv:8', 'inProgress'],
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

it('streams v4 documents to the exact full-fold Home view without retaining episode rows', () => {
  const now = 1_800_000_000_000;
  const stamp = (value: number): [number, number, string] => [value, 0, 'aaaaaaaaaaaaaaaa'];
  const resetAt = now - 2500;
  const titleDocuments = applyOps(
    [
      {
        target: { type: 'tv', id: 40 },
        write: {
          kind: 'title',
          fields: { status: 'watched', reaction: 'love', dismissed: true },
          added_at: now - 10_000,
          at: stamp(now - 5000),
        },
      },
      { target: { type: 'tv', id: 40 }, write: { kind: 'series_reset', at: stamp(resetAt) } },
    ],
    () => undefined,
    now,
  );
  const stored: Row[] = [
    ...titleDocuments,
    {
      format: 4,
      kind: 'title',
      title: { type: 'movie', id: 41 },
      status: { value: 'watchlist', at: stamp(now - 3000) },
      addedAt: now - 20_000,
    } satisfies DocumentRow,
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 40 },
      season: 2,
      seasonReset: null,
      episodes: {
        20: {
          progress: null,
          imported: true,
          plays: {},
          cleared: null,
        },
        10: {
          progress: { value: 1, at: stamp(now - 3000), viewing: 1 },
          imported: false,
          plays: { 0: now - 3000 },
          cleared: null,
        },
      },
    } satisfies DocumentRow,
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 40 },
      season: 1,
      seasonReset: null,
      episodes: {
        2: {
          progress: { value: 1, at: stamp(now - 1500), viewing: 1 },
          imported: false,
          plays: { 0: now - 1500 },
          cleared: null,
        },
        5: {
          progress: {
            value: 0.4,
            at: stamp(now - 1000),
            viewing: 2,
            seconds: 500,
          },
          imported: false,
          plays: { 0: now - 1000 },
          cleared: null,
        },
      },
    } satisfies DocumentRow,
    ...[43, 42].map(
      (id) =>
        ({
          format: 4,
          kind: 'season',
          title: { type: 'tv', id },
          season: 1,
          seasonReset: null,
          episodes: {
            1: {
              progress: { value: 0.5, at: stamp(now - 900), viewing: 1 },
              imported: false,
              plays: { 0: now - 900 },
              cleared: null,
            },
          },
        }) satisfies DocumentRow,
    ),
    {
      format: 4,
      kind: 'season',
      title: { type: 'tv', id: 44 },
      season: 3,
      seasonReset: null,
      episodes: {
        7: { progress: null, imported: true, plays: {}, cleared: null },
      },
    } satisfies DocumentRow,
  ];
  const rows = stored.flatMap((row) => (isDocument(row) ? projectDocument(row, now) : [row]));
  const expected = selectHomeLibraryView(applyLog(emptyLibrary(), rows), rows);
  const direct = projectHomeLibraryView(stored, now);

  expect(direct).toEqual({ view: expected, rows: rows.length });
  expect(direct?.view.owned).toEqual(['tv:40', 'movie:41']);
  expect(direct?.view.watchlist).toEqual(['movie:41']);
  expect(
    direct?.view.continueLibrary.records.map(({ title, status }) => [title.type, title.id, status]),
  ).toEqual([['tv', 40, 'watched']]);
  expect(
    direct?.view.continueLibrary.marks.map(({ id, season, episode, fraction }) => [
      id,
      season,
      episode,
      fraction,
    ]),
  ).toEqual([
    [40, 1, 5, 0.4],
    [40, 1, 2, 1],
    [43, 1, 1, 0.5],
    [42, 1, 1, 0.5],
  ]);
  expect([...(direct?.view.continueLibrary.flags?.values() ?? [])]).toEqual([
    { type: 'tv', id: 44, season: 3, episode: 7 },
  ]);
  expect(direct?.view.continueLibrary.dismissed).toEqual(new Map([['tv:40', now - 5000]]));
  // A legacy episode can duplicate a document projection under another stored name, so it takes the full fallback.
  expect(
    projectHomeLibraryView(
      [
        ...stored,
        {
          kind: 'ep',
          schema: 2,
          title: { type: 'tv', id: 40 },
          season: 1,
          episode: 5,
          progress: { value: 0.8, at: stamp(now), viewing: 3 },
        } satisfies EpisodeRow,
      ],
      now,
    ),
  ).toBeUndefined();
});

it('asks for the layouts of the series watched most recently first', () => {
  const mark = (id: number, updatedAt: number) => ({
    type: 'tv',
    id,
    season: 1,
    episode: 1,
    fraction: 1,
    updatedAt,
    title: '',
    voteAverage: 0,
  });
  const library = foldFor([]);
  // Stored oldest first, as a library written over years is; Home shows the newest.
  library.marks = [mark(10, 100), mark(12, 300), mark(14, 200), mark(12, 50)];
  expect(selectHomeLibraryView(library, []).requiredShapeRefs).toEqual(['tv:12', 'tv:14', 'tv:10']);
});

it('scopes production Continue work to changed layouts and reuses policy for presentation changes', () => {
  const mark = (id: number, updatedAt: number, by: string) => ({
    type: 'tv' as const,
    id,
    season: 1,
    episode: 1,
    fraction: 0.5,
    seconds: id * 100,
    updatedAt,
    updatedBy: by,
    title: '',
    voteAverage: 0,
  });
  const shapes = new Map(
    [1, 2, 3].map((id) => [`tv:${id}`, { counts: new Map([[1, 3]]) }] as const),
  );
  const library: Library = {
    records: [],
    marks: [mark(1, 1_000, 'one'), mark(2, 1_000, 'two'), mark(3, 900, 'three')],
    flags: new Map(),
    shapes,
    dismissed: new Map(),
  };
  const devices = (name: string): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name: 'devices',
    values: { 'one.name': { value: { string: name }, at: [1, 0, 'test'] } },
  });
  let decisions = 0;
  const projector = new ContinueProjector((request) => {
    decisions++;
    return syncPolicy(request);
  });
  const stringify = vi.spyOn(JSON, 'stringify');
  const requestStrings = () =>
    stringify.mock.calls.filter(
      ([value]) =>
        typeof value === 'object' &&
        value !== null &&
        'op' in value &&
        value.op === 'continue_entry',
    ).length;

  try {
    const initial = continueItems(projector, library, devices('Living Room'));
    expect(initial.map(({ title }) => title.id)).toEqual([1, 2, 3]);
    expect(initial[0]).toMatchObject({ seconds: 100, device: 'Living Room' });
    expect({ decisions, requestStrings: requestStrings() }).toEqual({
      decisions: 3,
      requestStrings: 6,
    });

    decisions = 0;
    stringify.mockClear();
    const equalShapes = new Map(
      [...library.shapes].map(([key, shape]) => [
        key,
        {
          counts: new Map(shape.counts),
          ...(shape.lastAired ? { lastAired: { ...shape.lastAired } } : {}),
        },
      ]),
    );
    const unchanged = continueItems(
      projector,
      { ...library, shapes: equalShapes },
      devices('Bedroom'),
    );
    expect(unchanged).toEqual(
      initial.map((item) => (item.title.id === 1 ? { ...item, device: 'Bedroom' } : item)),
    );
    expect({ decisions, requestStrings: requestStrings() }).toEqual({
      decisions: 0,
      requestStrings: 0,
    });

    const changedShapes = equalShapes;
    changedShapes.get('tv:2')!.counts.set(1, 4);
    decisions = 0;
    stringify.mockClear();
    const incremented = { ...library, shapes: changedShapes };
    const changed = continueItems(projector, incremented, devices('Bedroom'));
    const changedWork = { decisions, requestStrings: requestStrings() };
    expect(changed.map(({ title }) => title.id)).toEqual([1, 2, 3]);
    expect(changed).toEqual(
      continueItems(new ContinueProjector(), incremented, devices('Bedroom')),
    );
    expect(changedWork).toEqual({
      decisions: 1,
      // One projector cache key and one syncPolicy request, rather than three of each.
      requestStrings: 2,
    });

    changedShapes.get('tv:2')!.lastAired = { season: 1, episode: 2 };
    decisions = 0;
    stringify.mockClear();
    const lastAiredChanged = continueItems(projector, incremented, devices('Bedroom'));
    const lastAiredWork = { decisions, requestStrings: requestStrings() };
    expect(lastAiredChanged).toEqual(
      continueItems(new ContinueProjector(), incremented, devices('Bedroom')),
    );
    expect(lastAiredWork).toEqual({ decisions: 1, requestStrings: 2 });

    changedShapes.delete('tv:2');
    decisions = 0;
    stringify.mockClear();
    const withoutLayout = { ...library, shapes: changedShapes };
    const removed = continueItems(projector, withoutLayout, devices('Bedroom'));
    const removedWork = { decisions, requestStrings: requestStrings() };
    expect(removed).toEqual(
      continueItems(new ContinueProjector(), withoutLayout, devices('Bedroom')),
    );
    expect(removedWork).toEqual({
      decisions: 1,
      requestStrings: 2,
    });

    const repositioned = {
      ...withoutLayout,
      marks: withoutLayout.marks.map((held) =>
        held.id === 1 ? { ...held, seconds: 777, updatedBy: 'one' } : held,
      ),
    };
    decisions = 0;
    stringify.mockClear();
    expect(continueItems(projector, repositioned, devices('Bedroom'))[0]).toMatchObject({
      title: { id: 1 },
      seconds: 777,
      device: 'Bedroom',
    });
    expect({ decisions, requestStrings: requestStrings() }).toEqual({
      decisions: 0,
      // Physical position is presentation, but a new marks array still takes the safe full invalidation path.
      requestStrings: 3,
    });

    const watched = {
      title: { type: 'tv' as const, id: 1, title: '' },
      status: 'watched' as const,
      progress: 1,
      progressAt: 1_100,
      addedAt: 1,
      deleted: false,
    };
    decisions = 0;
    stringify.mockClear();
    continueItems(projector, { ...repositioned, records: [watched] }, devices('Bedroom'));
    expect({ decisions, requestStrings: requestStrings() }).toEqual({
      decisions: 1,
      requestStrings: 4,
    });

    const deleted = { ...repositioned, records: [{ ...watched, deleted: true }] };
    decisions = 0;
    stringify.mockClear();
    const afterDelete = continueItems(projector, deleted, devices('Bedroom'));
    const deleteWork = { decisions, requestStrings: requestStrings() };
    expect(afterDelete).toEqual(
      continueItems(new ContinueProjector(), deleted, devices('Bedroom')),
    );
    expect(deleteWork).toEqual({ decisions: 1, requestStrings: 4 });

    const removedSeries = { ...deleted, marks: deleted.marks.slice(0, 2) };
    decisions = 0;
    stringify.mockClear();
    const afterRemoval = continueItems(projector, removedSeries, devices('Bedroom'));
    expect(afterRemoval.map(({ title }) => title.id)).toEqual([1, 2]);
    expect({ decisions, requestStrings: requestStrings() }).toEqual({
      decisions: 0,
      requestStrings: 2,
    });
  } finally {
    stringify.mockRestore();
  }
});

it('says the same standings when an episode mark moves a series already in progress', () => {
  const mark = (id: number, episode: number, updatedAt: number) => ({
    type: 'tv',
    id,
    season: 1,
    episode,
    fraction: 1,
    updatedAt,
    title: '',
    voteAverage: 0,
  });
  const before = foldFor([]);
  before.marks = [mark(10, 1, 100), mark(12, 1, 200)];
  const after = foldFor([]);
  // Series 10's next episode, marked last: its marks now come after series 12's.
  after.marks = [mark(12, 1, 200), mark(10, 1, 100), mark(10, 2, 300)];
  expect(selectHomeLibraryView(after, []).standings).toEqual(
    selectHomeLibraryView(before, []).standings,
  );
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
