import { describe, expect, it } from 'vitest';
import {
  addBoundaryCount,
  addBoundaryRow,
  boundaryCounts,
  boundarySummary,
} from './boundaryDiagnostics';
import type { Row } from './wire';

describe('split-household boundary diagnostics', () => {
  it('reduces activity, settings, delivery, legacy and unreadable work to bounded counts', () => {
    const profile = '00112233445566778899aabbccddeeff';
    const rows = [
      { kind: 'title', title: { type: 'movie', id: 550 } },
      { kind: 'season', title: { type: 'tv', id: 1399 }, season: 2 },
      { kind: 'ep', title: { type: 'tv', id: 1399 }, season: 2, episode: 3 },
      {
        kind: 'set',
        name: `profile:${profile}`,
        values: { token: { value: { string: 'https://private.example/token' } } },
      },
      { kind: 'delivery', provider: 'simkl', account: 'secret-account' },
      { kind: 'wat', title: { type: 'movie', id: 680 } },
    ] as unknown as Row[];
    const counts = boundaryCounts();
    for (const row of rows) addBoundaryRow(counts, row);
    addBoundaryCount(counts, 'unknown'); // unreadable kept work

    const diagnostic = boundarySummary(counts);
    expect(diagnostic).toBe('activity=3, settings=1, delivery=1, unknown=2');
    for (const secret of [
      'title:movie:550',
      'season:tv:1399:2',
      'ep:tv:1399:2:3',
      'wat:movie:680',
      profile,
      'secret-account',
      'https://private.example/token',
    ])
      expect(diagnostic).not.toContain(secret);
  });

  it('keeps diagnostic size constant as refused work grows', () => {
    const counts = boundaryCounts();
    for (let index = 0; index < 10_000; index++)
      addBoundaryRow(counts, {
        kind: 'title',
        title: { type: 'movie', id: index + 1 },
      } as Row);

    expect(boundarySummary(counts)).toBe('activity=10000');
  });
});
