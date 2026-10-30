import { describe, expect, it } from 'vitest';
import type { ContentServiceClientPort } from './contentServiceClient';
import { kidsHomeRows } from './kidsHome';

describe('kidsHomeRows', () => {
  it('looks up the posters den-edge does not know, so a row is not cut to the titles already seen', async () => {
    const asked: number[] = [];
    const content = {
      query: async (request: { kind: string; query?: { operation: string; page?: number } }) => {
        if (request.kind === 'titles') {
          const [ref] = (request as unknown as { titles: { type: 'movie'; id: number }[] }).titles;
          asked.push(ref!.id);
          return { titles: [{ ...ref, title: `Drawn ${ref!.id}`, posterPath: `/${ref!.id}.jpg` }] };
        }
        if (request.query?.operation === 'kids-home')
          return {
            answer: {
              state: 'ready',
              value: {
                operation: 'kids-home',
                rows: [
                  {
                    id: 'thomas',
                    title: 'All Aboard with Thomas',
                    heading: {
                      id: 'shelf.kids.thomas-and-friends',
                      args: {},
                      fallback: 'All Aboard with Thomas',
                    },
                    group: 'favorite-worlds',
                    source: { kind: 'query', query: 'Thomas and Friends', minimumScore: 0.79 },
                  },
                ],
              },
            },
          };
        return {
          answer: {
            state: 'ready',
            value: {
              operation: 'kids-row',
              titles:
                request.query?.page === 1
                  ? [
                      { type: 'movie', id: 1, title: 'Known', posterPath: '/1.jpg' },
                      { type: 'movie', id: 2, title: 'Unseen' },
                      { type: 'movie', id: 3, title: 'Unseen too' },
                    ]
                  : [],
            },
          },
        };
      },
    } as unknown as ContentServiceClientPort;

    const [row] = await kidsHomeRows(content);
    expect(row?.atlasHeading).toEqual({
      id: 'shelf.kids.thomas-and-friends',
      args: {},
      fallback: 'All Aboard with Thomas',
    });
    expect((await row!.load(1)).map((title) => title.id)).toEqual([1]);
    expect((await row!.load(2)).map((title) => [title.id, title.posterPath])).toEqual([
      [2, '/2.jpg'],
      [3, '/3.jpg'],
    ]);
    expect(asked).toEqual([2, 3]);
    // The billboard and the shelf share one page: asking again starts no second lookup.
    await row!.load(1);
    expect(asked).toEqual([2, 3]);
  });
});
