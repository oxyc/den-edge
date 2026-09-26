import { describe, expect, it } from 'vitest';
import { toTitle } from './tmdb';

describe('TMDB title countries', () => {
  it('prefers strict origin countries over the co-production list', () => {
    expect(
      toTitle(
        { type: 'movie', id: 937278 },
        {
          title: 'A Man Called Otto',
          origin_country: ['US'],
          production_countries: [{ iso_3166_1: 'SE' }, { iso_3166_1: 'US' }],
        },
      )?.countries,
    ).toEqual(['US']);
  });

  it('keeps the production-country fallback for older detail responses', () => {
    expect(
      toTitle(
        { type: 'movie', id: 1 },
        {
          title: 'Older response',
          production_countries: [{ iso_3166_1: 'SE' }, { iso_3166_1: 'DK' }],
        },
      )?.countries,
    ).toEqual(['SE', 'DK']);
  });
});
