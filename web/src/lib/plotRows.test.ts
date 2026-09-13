import { describe, expect, it } from 'vitest';
import { plotRows } from './plotRows';

describe('plotRows', () => {
  it('pages a plot row from atlas and reads its titles as cards the hide rules can judge', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
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
            },
            { type: 'person', id: 9, title: 'Nobody' },
          ],
          total: 1,
        }),
      );
    }) as unknown as typeof fetch;
    const rows = plotRows('/atlas/auto_nfx', 'movie', fetchImpl);
    const slowBleak = rows.find((r) => r.id === 'plot-slow-bleak')!;
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
      },
    ]);
    expect(asked).toEqual([
      '/atlas/auto_nfx/index/plot/movie.json?pacing=slow-burn&tone=bleak&skip=24&limit=24',
    ]);
  });

  it('offers no series rows, and fails a page atlas could not answer', async () => {
    expect(plotRows('/atlas', 'tv')).toEqual([]);
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(plotRows('/atlas', 'movie', down)[0]!.load(1)).rejects.toThrow('503');
  });
});
