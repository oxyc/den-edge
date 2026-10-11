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

describe('TMDB title people', () => {
  it('names a director who also stars once', () => {
    expect(
      toTitle(
        { type: 'movie', id: 1236045 },
        {
          title: 'Animals',
          credits: {
            crew: [{ id: 880, job: 'Director' }],
            cast: [{ id: 880 }, { id: 11703 }, { id: 12214 }],
          },
        },
      )?.people,
    ).toEqual([880, 11703, 12214]);
  });
});
