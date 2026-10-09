import { describe, expect, it } from 'vitest';
import { parseIconicStudios } from './iconicStudios';

describe('iconic studios', () => {
  it('keeps valid, named QIDs once and in Atlas order', () => {
    expect(
      parseIconicStudios({
        studios: [
          { id: 'Q159846', name: 'A24' },
          { id: 'Q159846', name: 'A24 duplicate' },
          { id: '159', name: 'No Q' },
          { id: 'Q2', name: '  ' },
          null,
        ],
      }),
    ).toEqual([{ id: 'Q159846', name: 'A24' }]);
    expect(parseIconicStudios({ studios: 'not a list' })).toEqual([]);
  });
});
