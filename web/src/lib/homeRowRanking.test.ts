import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { rankHomeRows, type HomeTasteTitle } from './homeRowRanking';

const bluey: Title = { type: 'tv', id: 82728, title: 'Bluey', genreIds: [16, 10762], year: 2018 };
const taste: HomeTasteTitle[] = [{ title: bluey, weight: 1, updatedAt: 1_000 }];

describe('Home row ranking', () => {
  it('floats a matching world without removing rows or moving fixed shelves', () => {
    const rows = [
      { id: 'fixed' },
      { id: 'moomins', affinity: { group: 'worlds', refs: [{ type: 'tv' as const, id: 61617 }] } },
      { id: 'bluey', affinity: { group: 'worlds', refs: [{ type: 'tv' as const, id: 82728 }] } },
      { id: 'animation', affinity: { group: 'themes', genres: [16] } },
    ];
    expect(rankHomeRows(rows, taste, 1_000).map(({ id }) => id)).toEqual([
      'fixed',
      'bluey',
      'animation',
      'moomins',
    ]);
  });

  it('preserves the exact fallback order without useful taste', () => {
    const rows = [
      { id: 'one', affinity: { group: 'a', genres: [35] } },
      { id: 'two' },
      { id: 'three', affinity: { group: 'b', decades: [1980] } },
    ];
    expect(rankHomeRows(rows, [], 1_000)).toEqual(rows);
    expect(rankHomeRows(rows, taste, 1_000)).toEqual(rows);
  });

  it('sends disliked matches down while retaining them', () => {
    const rows = [
      { id: 'bluey', affinity: { group: 'worlds', refs: [{ type: 'tv' as const, id: 82728 }] } },
      { id: 'comedy', affinity: { group: 'themes', genres: [35] } },
    ];
    expect(rankHomeRows(rows, [{ ...taste[0]!, weight: -1.5 }], 1_000).map(({ id }) => id)).toEqual(
      ['comedy', 'bluey'],
    );
  });
});
