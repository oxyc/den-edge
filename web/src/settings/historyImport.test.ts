import { describe, expect, it } from 'vitest';
import { historyImportItems } from './historyImport';

describe('historyImportItems', () => {
  it('groups films and episodes into semantic import items', () => {
    expect(
      historyImportItems(
        [
          { type: 'movie', id: 1, name: 'Film', source: 'Film', at: 10 },
          { type: 'tv', id: 2, name: 'Show', source: 'Show: One', season: 1, episode: 1, at: 20 },
          { type: 'tv', id: 2, name: 'Show', source: 'Show: Two', season: 1, episode: 2, at: 30 },
        ],
        {
          2: {
            counts: new Map([[1, 2]]),
            lastAired: { season: 1, episode: 2 },
          },
        },
      ),
    ).toEqual([
      { key: 'movie:1', item: { title: { type: 'movie', id: 1 }, watchedAt: 10 } },
      {
        key: 'tv:2',
        item: {
          title: { type: 'tv', id: 2 },
          episodes: [
            { season: 1, episode: 1, watchedAt: 20 },
            { season: 1, episode: 2, watchedAt: 30 },
          ],
          complete: true,
        },
      },
    ]);
  });

  it('does not claim a partial series is complete', () => {
    const [planned] = historyImportItems(
      [{ type: 'tv', id: 2, name: 'Show', source: 'Show', season: 1, episode: 1, at: 20 }],
      {
        2: {
          counts: new Map([[1, 2]]),
          lastAired: { season: 1, episode: 2 },
        },
      },
    );
    expect(planned?.item.complete).toBeUndefined();
  });
});
