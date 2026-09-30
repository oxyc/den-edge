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
  it('resolves movies and episodes and preserves their viewing times', async () => {
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

  it('imports partial and duration-less plays without asking TMDB for runtime', async () => {
    let runtimeCalls = 0;
    const result = await planPrimeImport(
      [
        movie({ title: 'Complete', rawTitle: 'Complete', durationSeconds: undefined }),
        movie({ title: 'Partial', rawTitle: 'Partial', watchedSeconds: 2_000 }),
        movie({ title: 'Unknown', rawTitle: 'Unknown', durationSeconds: undefined }),
      ],
      fake({
        searchMulti: async (query) => [
          { type: 'movie', id: { Complete: 1, Partial: 2, Unknown: 3 }[query]!, name: query },
        ],
        runtime: async (_type, id) => {
          runtimeCalls++;
          return id === 1 ? 100 : null;
        },
      }),
    );
    expect(result.marks.map((mark) => mark.source)).toEqual(['Complete', 'Partial', 'Unknown']);
    expect(runtimeCalls).toBe(0);
  });

  it('accepts a unique TMDB alternate-title result and uses runtime to split film namesakes', async () => {
    const result = await planPrimeImport(
      [
        movie({ title: 'Título localizado', rawTitle: 'Título localizado' }),
        movie({
          title: "Dr. Seuss' How the Grinch Stole Christmas",
          rawTitle: "Dr. Seuss' How the Grinch Stole Christmas",
          durationSeconds: 6_000,
        }),
      ],
      fake({
        searchMulti: async (query) =>
          query === 'Título localizado'
            ? [{ type: 'movie', id: 10, name: 'English Title', year: 2020 }]
            : query === 'How the Grinch Stole Christmas'
              ? [
                  { type: 'movie', id: 20, name: 'How the Grinch Stole Christmas', year: 2000 },
                  { type: 'movie', id: 21, name: 'How the Grinch Stole Christmas!', year: 1966 },
                ]
              : [],
        searchMovie: async () => [],
        runtime: async (_type, id) => (id === 20 ? 104 : 26),
      }),
    );
    expect(result.marks.map((mark) => mark.id)).toEqual([10, 20]);
  });

  it('prefers the composite history episode, understands localized numbers, and checks specials', async () => {
    const result = await planPrimeImport(
      [
        episode({
          title: 'The Next Episode',
          rawTitle: 'The Actual Episode-The Show - Season 1',
          show: 'The Show',
          season: 1,
        }),
        episode({
          title: 'Episodio 1',
          rawTitle: 'Episodio 1-Other Show - Season 1',
          show: 'Other Show',
          season: 1,
        }),
        episode({
          title: 'Swan Song',
          rawTitle: 'Swan Song-Third Show - Season 8',
          show: 'Third Show',
          season: 8,
        }),
      ],
      fake({
        searchTv: async (query) => [
          {
            type: 'tv',
            id: { 'The Show': 10, 'Other Show': 11, 'Third Show': 12 }[query]!,
            name: query,
          },
        ],
        show: async (id) => (id === 12 ? shape({ 0: 1, 8: 1 }) : shape({ 1: 1 })),
        episodes: async (id, season) => {
          if (id === 10) return [{ number: 1, name: 'The Actual Episode' }];
          if (id === 11) return [{ number: 1, name: 'Episode One' }];
          return season === 0
            ? [{ number: 1, name: 'Swan Song' }]
            : [{ number: 1, name: 'Finale' }];
        },
      }),
    );
    expect(result.marks.map(({ id, season, episode }) => ({ id, season, episode }))).toEqual([
      { id: 10, season: 1, episode: 1 },
      { id: 11, season: 1, episode: 1 },
      { id: 12, season: 0, episode: 1 },
    ]);
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
      [
        episode({
          season: undefined,
          title: 'Pilot',
          rawTitle: "Pilot-Clarkson's Farm - Season 5",
          watchedSeconds: 3_000,
        }),
      ],
      fake({
        show: async () => shape({ 1: 1, 2: 1 }),
        episodes: async (_id, season) => [{ number: 1, name: 'Pilot', runtime: 50 + season }],
      }),
    );
    expect(ambiguous.marks).toEqual([]);
    expect(ambiguous.ambiguous).toEqual(["Pilot-Clarkson's Farm - Season 5"]);
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

  it('places a complete season in viewing order when provider and TMDB episode names differ', async () => {
    const result = await planPrimeImport(
      [
        episode({
          title: 'Uno',
          rawTitle: 'Uno-The Show - Season 1',
          show: 'The Show',
          season: 1,
          watchedAt: 100,
        }),
        episode({
          title: 'Dos',
          rawTitle: 'Dos-The Show - Season 1',
          show: 'The Show',
          season: 1,
          watchedAt: 200,
        }),
      ],
      fake({
        searchTv: async () => [{ type: 'tv', id: 2, name: 'The Show' }],
        show: async () => shape({ 1: 2 }),
        episodes: async () => [
          { number: 1, name: 'First', runtime: 50 },
          { number: 2, name: 'Second', runtime: 50 },
        ],
      }),
    );
    expect(result.marks.map((mark) => mark.episode)).toEqual([1, 2]);
    expect(result.unmatched).toEqual([]);
  });

  it('identifies a show omitted by Prime only when every episode corroborates one complete season', async () => {
    const result = await planPrimeImport(
      [
        episode({
          title: 'The Show',
          rawTitle: 'The Show-Season 01',
          show: 'Season 01',
          season: 1,
        }),
        episode({ title: 'Second', rawTitle: 'Second-Season 01', show: 'Season 01', season: 1 }),
      ],
      fake({
        searchTv: async (query) =>
          query === 'The Show' ? [{ type: 'tv', id: 2, name: 'The Show' }] : [],
        show: async () => shape({ 1: 2 }),
        episodes: async () => [
          { number: 1, name: 'The Show', runtime: 50 },
          { number: 2, name: 'Second', runtime: 50 },
        ],
      }),
    );
    expect(result.marks.map((mark) => mark.episode)).toEqual([1, 2]);
    expect(result.unmatched).toEqual([]);
  });
});
