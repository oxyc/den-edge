import { describe, expect, it } from 'vitest';
import { atlasRows } from './atlasRows';

describe('atlasRows', () => {
  const answering = (asked: string[]) =>
    (async (url: string) => {
      asked.push(url);
      return new Response(
        JSON.stringify({
          titles: [
            {
              type: 'movie',
              id: 2,
              title: 'Two',
              posterPath: '/2.jpg',
              year: 1995,
              genreIds: [18],
              originalLanguage: 'ko',
              imdbId: 'tt0000002',
            },
            { type: 'person', id: 9, title: 'Nobody' },
          ],
          total: 1,
        }),
      );
    }) as unknown as typeof fetch;

  it('pages a plot facet row from atlas and reads its titles as cards the hide rules can judge', async () => {
    const asked: string[] = [];
    const rows = atlasRows('/atlas/auto_nfx', 'movie', answering(asked));
    const slowBleak = rows.find((r) => r.id === 'atlas-plot-slow-bleak-movie')!;
    expect(slowBleak.title).toBe('Slow-Burn and Bleak');
    expect(await slowBleak.load(2)).toEqual([
      {
        type: 'movie',
        id: 2,
        title: 'Two',
        posterPath: '/2.jpg',
        year: 1995,
        genreIds: [18],
        originalLanguage: 'ko',
        imdbId: 'tt0000002',
      },
    ]);
    expect(asked).toEqual([
      '/atlas/auto_nfx/index/row/movie.json?pacing=slow-burn&tone=bleak&skip=24&limit=24',
    ]);
  });

  it('asks for a mood or subgenre row by its label, series by atlas’s name for them', async () => {
    const asked: string[] = [];
    const series = atlasRows('/atlas', 'tv', answering(asked));
    await series.find((r) => r.id === 'atlas-mood-dark-gritty-tv')!.load(1);
    await series.find((r) => r.id === 'atlas-subgenre-whodunit-tv')!.load(1);
    expect(asked).toEqual([
      '/atlas/index/row/series.json?mood=Dark+%26+Gritty&skip=0&limit=24',
      '/atlas/index/row/series.json?subgenre=Whodunit%2FMurder+Mystery&skip=0&limit=24',
    ]);
  });

  it('fails a page atlas could not answer', async () => {
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(atlasRows('/atlas', 'movie', down)[0]!.load(1)).rejects.toThrow('503');
  });
});
