import { describe, expect, it } from 'vitest';
import { atlasRows } from './atlasRows';
import { ContentAuthority } from './contentAuthority';
import type { ContentServiceClientPort } from './contentServiceClient';

describe('atlasRows', () => {
  const answering = (asked: string[]) =>
    (async (url: string) => {
      asked.push(url);
      if (url === '/metadata/title/query') {
        const observedAt = Date.now();
        return new Response(
          JSON.stringify({
            entries: [
              {
                type: 'movie',
                id: 2,
                source: 'tmdb',
                fields: {
                  rating: { value: 7.8, observedAt },
                  voteCount: { value: 12, observedAt },
                },
              },
            ],
          }),
        );
      }
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
              likely: true,
            },
            { type: 'person', id: 9, title: 'Nobody' },
          ],
          total: 1,
        }),
      );
    }) as unknown as typeof fetch;

  const content = (base: string, fetchImpl: typeof fetch): ContentServiceClientPort => {
    const authority = new ContentAuthority(
      {
        tmdb: () => undefined,
        omdb: () => undefined,
        contentWarnings: () => undefined,
        atlas: () => base,
      },
      { providerFetch: fetchImpl },
    );
    return {
      query: (request, signal) =>
        authority.query(request, signal ?? new AbortController().signal) as never,
      onStatus: () => () => {},
    };
  };

  it('pages a plot facet row from atlas and reads its titles as cards the hide rules can judge', async () => {
    const asked: string[] = [];
    const rows = atlasRows(content('/atlas/auto_nfx', answering(asked)), 'movie');
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
        likely: true,
        rating: 7.8,
        ratingSource: 'tmdb',
        votes: 12,
      },
    ]);
    expect(asked).toEqual([
      '/atlas/auto_nfx/index/row/movie.json?pacing=slow-burn&tone=bleak&skip=24&limit=24',
      '/metadata/title/query',
    ]);
  });

  it('asks for a mood or subgenre row by its label, series by atlas’s name for them', async () => {
    const asked: string[] = [];
    const series = atlasRows(content('/atlas', answering(asked)), 'tv');
    await series.find((r) => r.id === 'atlas-mood-dark-gritty-tv')!.load(1);
    await series.find((r) => r.id === 'atlas-subgenre-whodunit-tv')!.load(1);
    expect(asked).toEqual([
      '/atlas/index/row/series.json?mood=Dark+%26+Gritty&skip=0&limit=24',
      '/metadata/title/query',
      '/atlas/index/row/series.json?subgenre=Whodunit%2FMurder+Mystery&skip=0&limit=24',
      '/metadata/title/query',
    ]);
  });

  it('fails a page atlas could not answer', async () => {
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(atlasRows(content('/atlas', down), 'movie')[0]!.load(1)).rejects.toThrow();
  });
});
