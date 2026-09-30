import { describe, expect, it } from 'vitest';
import type { PrimeViewing } from './primeImport';
import { planPrimeImport } from './primeImportPlan';
import type { ImportShow, ViewingLookups, ViewingSearchHit } from './viewingImport';

const movie = (overrides: Partial<PrimeViewing> = {}): PrimeViewing => ({
  kind: 'movie',
  title: 'Goodrich',
  description: 'A film',
  rawTitle: 'Goodrich',
  watchedAt: 200,
  watchedSeconds: 6_000,
  durationSeconds: 6_100,
  ...overrides,
});

const episode = (overrides: Partial<PrimeViewing> = {}): PrimeViewing => ({
  kind: 'episode',
  title: 'Updating',
  description: 'A farm episode',
  rawTitle: "Updating-Clarkson's Farm - Season 5",
  show: "Clarkson's Farm",
  season: 5,
  watchedAt: 300,
  watchedSeconds: 3_100,
  ...overrides,
});

const shape = (counts: Record<number, number>): ImportShow => ({
  counts: new Map(Object.entries(counts).map(([season, count]) => [Number(season), count])),
});

function fake(overrides: Partial<ViewingLookups> = {}): ViewingLookups {
  return {
    searchMulti: async (query) => [{ type: 'movie', id: 1, name: query, year: 2024 }],
    searchTv: async (query) => [{ type: 'tv', id: 2, name: query, year: 2019 }],
    show: async () => shape({ 5: 2 }),
    episodes: async () => [
      { number: 1, name: 'Updating', runtime: 52 },
      { number: 2, name: 'Other', runtime: 51 },
    ],
    runtime: async () => 100,
    ...overrides,
  };
}

describe('Prime import planning', () => {
  it('resolves completed movies and episodes and preserves their viewing times', async () => {
    const progress: number[] = [];
    const result = await planPrimeImport([movie(), episode()], fake(), (done) =>
      progress.push(done),
    );
    expect(result.marks).toEqual([
      {
        type: 'movie',
        id: 1,
        name: 'Goodrich',
        year: 2024,
        source: 'Goodrich',
        at: 200,
      },
      {
        type: 'tv',
        id: 2,
        name: "Clarkson's Farm",
        year: 2019,
        source: "Clarkson's Farm",
        season: 5,
        episode: 1,
        at: 300,
      },
    ]);
    expect(result.shows[2]).toEqual(shape({ 5: 2 }));
    expect(progress.sort()).toEqual([1, 2]);
  });

  it('uses TMDB runtime only when Prime has no duration and refuses partial or unknown plays', async () => {
    let runtimeCalls = 0;
    const result = await planPrimeImport(
      [
        movie({ title: 'Complete', rawTitle: 'Complete', durationSeconds: undefined }),
        movie({ title: 'Partial', rawTitle: 'Partial', watchedSeconds: 2_000 }),
        movie({ title: 'Unknown', rawTitle: 'Unknown', durationSeconds: undefined }),
      ],
      fake({
        runtime: async (_type, id) => {
          runtimeCalls++;
          return id === 1 ? 100 : null;
        },
      }),
    );
    // The fake search gives every film id 1, so the complete runtime fallback and latest completed occurrence dedupe.
    expect(result.marks).toHaveLength(1);
    expect(result.incomplete).toEqual([{ title: 'Partial', fraction: 2_000 / 6_100 }]);
    expect(result.unknownDuration).toEqual([]);
    // Only duration-less observations ask, and their shared TMDB identity is cached.
    expect(runtimeCalls).toBe(1);

    const unknown = await planPrimeImport(
      [movie({ durationSeconds: undefined })],
      fake({ runtime: async () => null }),
    );
    expect(unknown.marks).toEqual([]);
    expect(unknown.unknownDuration).toEqual(['Goodrich']);
  });

  it('uses episode evidence to choose between namesake shows', async () => {
    const namesakes: ViewingSearchHit[] = [
      { type: 'tv', id: 10, name: 'The Show' },
      { type: 'tv', id: 11, name: 'The Show' },
    ];
    const result = await planPrimeImport(
      [episode({ show: 'The Show', season: 1, title: 'The Right Episode', watchedSeconds: 3_000 })],
      fake({
        searchTv: async () => namesakes,
        show: async () => shape({ 1: 1 }),
        episodes: async (id) => [
          { number: 1, name: id === 11 ? 'The Right Episode' : 'Something Else', runtime: 50 },
        ],
      }),
    );
    expect(result.marks.map((mark) => mark.id)).toEqual([11]);
  });

  it('searches every season only when Prime omitted one, and rejects a cross-season ambiguity', async () => {
    const ambiguous = await planPrimeImport(
      [episode({ season: undefined, title: 'Pilot', watchedSeconds: 3_000 })],
      fake({
        show: async () => shape({ 1: 1, 2: 1 }),
        episodes: async (_id, season) => [{ number: 1, name: 'Pilot', runtime: 50 + season }],
      }),
    );
    expect(ambiguous.marks).toEqual([]);
    expect(ambiguous.ambiguous).toEqual(["Updating-Clarkson's Farm - Season 5"]);
  });

  it('deduplicates a rewatch to its latest date and skips a title already seen locally', async () => {
    const result = await planPrimeImport(
      [movie({ watchedAt: 100 }), movie({ watchedAt: 500 }), episode()],
      fake(),
      undefined,
      (ref) => ref.type === 'tv',
    );
    expect(result.marks).toHaveLength(1);
    expect(result.marks[0]!.at).toBe(500);
    expect(result.known).toBe(1);
  });
});
