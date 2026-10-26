import { describe, expect, it, vi } from 'vitest';
import { watchedHistory } from './history';
import { MaterializedHistoryIndex, type HistoryIndexSource } from './historyIndex';
import { titleKey, type Title } from './library';
import { projectDocument } from './libraryV4';
import type { HistoryItem } from './libraryServiceProtocol';
import type { DocumentRow, Stamp } from './wire';

const DEVICE = 'aaaaaaaaaaaaaaaa';
const stamp = (at: number): Stamp => [at, 0, DEVICE];
const localYear = (year: number): number => new Date(year, 5, 15, 12).getTime();
const source = (
  generation: string,
  version: number,
  revision = `revision-${version}`,
): HistoryIndexSource => ({
  generation,
  version,
  revision,
  reconsiderAt: null,
});

const movie = (
  id: number,
  watchedAt: number,
  fields: Record<string, unknown> = {},
): DocumentRow => ({
  format: 4,
  kind: 'title',
  title: { type: 'movie', id },
  status: { value: 'watched', at: stamp(watchedAt) },
  addedAt: watchedAt,
  ...fields,
});

const series = (
  id: number,
  episodes: Array<{ season: number; episode: number; watchedAt: number }>,
): DocumentRow[] => {
  const bySeason = new Map<number, Record<number, unknown>>();
  for (const episode of episodes) {
    const held = bySeason.get(episode.season) ?? {};
    held[episode.episode] = {
      progress: { value: 1, at: stamp(episode.watchedAt), viewing: 0 },
      imported: false,
      plays: { 0: episode.watchedAt },
      cleared: null,
    };
    bySeason.set(episode.season, held);
  }
  return [
    {
      format: 4,
      kind: 'title',
      title: { type: 'tv', id },
      status: { value: 'watchlist', at: stamp(1) },
      addedAt: 1,
    },
    ...[...bySeason].map(([season, held]): DocumentRow => ({
      format: 4,
      kind: 'season',
      title: { type: 'tv', id },
      season,
      seasonReset: null,
      episodes: held,
    })),
  ];
};

const identities = (items: readonly HistoryItem[]): string[] =>
  items.map(({ title }) => `${title.type}:${title.id}`);

const allPages = (
  index: MaterializedHistoryIndex,
  filter: Parameters<MaterializedHistoryIndex['page']>[0] = {},
): HistoryItem[] => {
  const found: HistoryItem[] = [];
  let cursor: string | undefined;
  do {
    const page = index.page(filter, cursor, 7)!;
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return found;
};

describe('materialized History index', () => {
  it('pages in stable keyset order and reports global and type/year facets', () => {
    const y2024 = localYear(2024);
    const y2019 = localYear(2019);
    const documents = [
      movie(2, y2024),
      movie(1, y2024),
      movie(3, y2019),
      // An import with no known time sorts last and belongs to Unknown.
      movie(4, 0),
      ...series(10, [
        { season: 1, episode: 1, watchedAt: y2024 + 1 },
        { season: 1, episode: 2, watchedAt: y2024 + 2 },
      ]),
    ];
    const index = new MaterializedHistoryIndex(source('generation-a', 12), documents, y2024 + 10);

    const first = index.page({}, undefined, 2)!;
    expect(identities(first.items)).toEqual(['tv:10', 'movie:1']);
    expect(first).toMatchObject({
      total: 5,
      facets: {
        all: 5,
        movie: 4,
        tv: 1,
        years: [
          { year: '2024', all: 3, movie: 2, tv: 1 },
          { year: '2019', all: 1, movie: 1, tv: 0 },
          { year: 'unknown', all: 1, movie: 1, tv: 0 },
        ],
      },
    });

    const second = index.page({}, first.nextCursor, 2)!;
    const last = index.page({}, second.nextCursor, 2)!;
    expect(identities([...first.items, ...second.items, ...last.items])).toEqual([
      'tv:10',
      'movie:1',
      'movie:2',
      'movie:3',
      'movie:4',
    ]);
    expect(new Set(identities([...first.items, ...second.items, ...last.items])).size).toBe(5);
    expect(last.nextCursor).toBeUndefined();

    const movies2024 = index.page({ type: 'movie', year: '2024' }, undefined, 48)!;
    expect(movies2024.total).toBe(2);
    expect(identities(movies2024.items)).toEqual(['movie:1', 'movie:2']);
    expect(index.page({ type: 'tv', year: '2019' })?.items).toEqual([]);
    expect(index.page({ year: 'unknown' })?.items.map((item) => item.watchedAt)).toEqual([0]);
  });

  it('rejects cursors from another filter or revision instead of mixing snapshots', () => {
    const documents = [movie(1, 3_000), movie(2, 2_000), movie(3, 1_000)];
    const index = new MaterializedHistoryIndex(source('generation-a', 3), documents, 4_000);
    const first = index.page({}, undefined, 1)!;

    expect(index.page({ type: 'movie' }, first.nextCursor, 1)).toBeNull();
    expect(index.page({}, `${first.nextCursor}\nextra`, 1)).toBeNull();

    index.update({ type: 'movie', id: 3 }, [movie(3, 5_000)], source('generation-a', 4), 5_001);
    expect(index.page({}, first.nextCursor, 1)).toBeNull();
    expect(identities(index.page({}, undefined, 3)!.items)).toEqual([
      'movie:3',
      'movie:1',
      'movie:2',
    ]);
  });

  it('updates or removes only the changed title while preserving the other page entries', () => {
    const documents = [movie(1, 3_000), movie(2, 2_000), ...series(10, [])];
    const index = new MaterializedHistoryIndex(source('generation-a', 3), documents, 4_000);
    const before = index.page({}, undefined, 48)!;
    expect(identities(before.items)).toEqual(['movie:1', 'movie:2']);

    index.update(
      { type: 'movie', id: 2 },
      [movie(2, 2_000, { deleted: { value: true, at: stamp(4_000) } })],
      source('generation-a', 4),
      4_001,
    );
    expect(identities(index.page({}, undefined, 48)!.items)).toEqual(['movie:1']);

    index.update(
      { type: 'tv', id: 10 },
      series(10, [{ season: 1, episode: 1, watchedAt: 5_000 }]),
      source('generation-a', 5),
      5_001,
    );
    expect(index.page({}, undefined, 48)).toMatchObject({
      total: 2,
      items: [
        {
          title: { type: 'tv', id: 10 },
          watchedAt: 5_000,
          episode: { season: 1, episode: 1 },
          episodes: 1,
        },
        { title: { type: 'movie', id: 1 }, watchedAt: 3_000, episodes: 0 },
      ],
    });
  });

  it('applies title and season resets, then restores a later rewatch without stale episode counts', () => {
    const ref = { type: 'tv' as const, id: 10 };
    const documents = series(10, [
      { season: 1, episode: 1, watchedAt: 1_000 },
      { season: 1, episode: 2, watchedAt: 2_000 },
    ]);
    documents[0] = { ...documents[0]!, episodesReset: stamp(1_500) };
    const index = new MaterializedHistoryIndex(source('generation-a', 1), documents, 4_000);
    expect(index.page()!.items).toMatchObject([
      { title: ref, episodes: 1, episode: { season: 1, episode: 2 }, watchedAt: 2_000 },
    ]);

    const reset = documents.map((document) =>
      document.kind === 'season' ? { ...document, seasonReset: stamp(2_500) } : document,
    );
    index.update(ref, reset, source('generation-a', 2), 4_000);
    expect(index.page()!.items).toEqual([]);

    const rewatched = series(10, [{ season: 1, episode: 2, watchedAt: 3_000 }]);
    rewatched[0] = { ...rewatched[0]!, episodesReset: stamp(1_500) };
    rewatched[1] = { ...rewatched[1]!, seasonReset: stamp(2_500) };
    index.update(ref, rewatched, source('generation-a', 3), 4_000);
    expect(index.page()!.items).toMatchObject([
      { title: ref, episodes: 1, episode: { season: 1, episode: 2 }, watchedAt: 3_000 },
    ]);
  });

  it('binds otherwise identical pages to the source generation', () => {
    const documents = [movie(1, 1_000), movie(2, 900)];
    const oldIndex = new MaterializedHistoryIndex(source('generation-a', 2), documents, 2_000);
    const old = oldIndex.page({}, undefined, 1)!;
    const restoredIndex = new MaterializedHistoryIndex(source('generation-b', 2), documents, 2_000);

    expect(restoredIndex.revision).not.toBe(oldIndex.revision);
    expect(restoredIndex.page({}, old.nextCursor, 1)).toBeNull();
  });

  it('refiles one serialized snapshot in the current viewer timezone when it restores', () => {
    const nearNewYear = Date.UTC(2024, 0, 1, 1);
    const heldSource = source('generation-a', 1);
    const utc = new MaterializedHistoryIndex(
      heldSource,
      [movie(1, nearNewYear)],
      nearNewYear + 1,
      'UTC',
    );
    const snapshot = utc.snapshot();
    expect(utc.page({ year: '2024' })?.total).toBe(1);
    const nativeResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...nativeResolvedOptions.call(this), timeZone: 'America/Los_Angeles' };
      });
    try {
      const restored = MaterializedHistoryIndex.restore(snapshot)!;
      expect(restored.page({ year: '2023' })?.total).toBe(1);
      expect(restored.page({ year: '2024' })?.total).toBe(0);
      expect(restored.revision).not.toBe(utc.revision);
      expect(restored.page()!.items).toEqual(utc.page()!.items);
    } finally {
      resolvedOptions.mockRestore();
    }
    expect(
      MaterializedHistoryIndex.restore({
        ...snapshot,
        source: { ...snapshot.source, revision: '' },
      }),
    ).toBeNull();
  });

  it('stays differential-equivalent through deterministic mixed-title edit sequences', () => {
    let randomState = 0x6d2b79f5;
    const random = (limit: number) => {
      randomState = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
      randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
      return ((randomState ^ (randomState >>> 14)) >>> 0) % limit;
    };
    const now = localYear(2026);
    const documents = new Map<string, DocumentRow[]>();
    const refs = Array.from({ length: 30 }, (_, index) => ({
      type: index % 3 ? ('tv' as const) : ('movie' as const),
      id: index + 1,
    }));
    for (const ref of refs)
      documents.set(
        titleKey(ref),
        ref.type === 'movie'
          ? [movie(ref.id, 0, { status: { value: 'watchlist', at: stamp(1) } })]
          : series(ref.id, []),
      );
    let version = 1;
    const index = new MaterializedHistoryIndex(
      source('generation-random', version),
      [...documents.values()].flat(),
      now,
    );

    for (let step = 0; step < 120; step++) {
      const ref = refs[random(refs.length)]!;
      const watchedAt = random(9) === 0 ? 0 : localYear(2018 + random(9)) + random(10_000);
      let replacement: DocumentRow[];
      if (ref.type === 'movie') {
        const watched = random(4) !== 0;
        const deleted = watched && random(7) === 0;
        replacement = [
          movie(ref.id, watchedAt, {
            ...(!watched ? { status: { value: 'watchlist', at: stamp(step + 2) } } : {}),
            ...(deleted
              ? { deleted: { value: true, at: stamp(Math.max(watchedAt + 1, step + 3)) } }
              : {}),
          }),
        ];
      } else {
        const count = random(6);
        replacement = series(
          ref.id,
          Array.from({ length: count }, (_, episode) => ({
            season: random(5) === 0 ? 0 : 1 + random(3),
            episode: episode + 1,
            watchedAt: watchedAt + episode,
          })),
        );
        if (count && random(8) === 0)
          replacement[0] = {
            ...replacement[0]!,
            deleted: { value: true, at: stamp(Math.max(watchedAt + count, step + 3)) },
          };
      }
      const stale = index.page({}, undefined, 1)?.nextCursor;
      documents.set(titleKey(ref), replacement);
      version++;
      index.update(ref, replacement, source('generation-random', version), now);
      if (stale) expect(index.page({}, stale, 1)).toBeNull();

      const held = [...documents.values()].flat();
      const names = new Map<string, Title>(
        refs.map((title) => [titleKey(title), { ...title, title: titleKey(title) }]),
      );
      const expected = watchedHistory(
        held.flatMap((document) => projectDocument(document, now)),
        names,
      ).map(({ title, at, episode, episodes }): HistoryItem => ({
        title: { type: title.type, id: title.id },
        watchedAt: at,
        ...(episode ? { episode } : {}),
        episodes,
      }));
      expect(allPages(index)).toEqual(expected);
      expect(allPages(index, { type: 'movie' })).toEqual(
        expected.filter((item) => item.title.type === 'movie'),
      );
      expect(allPages(index, { type: 'tv' })).toEqual(
        expected.filter((item) => item.title.type === 'tv'),
      );
    }
  });
});
