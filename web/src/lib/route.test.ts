import { describe, expect, it } from 'vitest';
import { parseRoute, personHref, titleHref } from './route';

describe('routes', () => {
  it('reads each page from the fragment', () => {
    expect(parseRoute('#settings')).toEqual({ page: 'settings' });
    expect(parseRoute('#search')).toEqual({ page: 'search' });
    expect(parseRoute('#movies')).toEqual({ page: 'movies' });
    expect(parseRoute('#series')).toEqual({ page: 'series' });
    expect(parseRoute('#title/tv/1399')).toEqual({ page: 'title', type: 'tv', id: 1399 });
    expect(parseRoute(titleHref({ type: 'movie', id: 550 }))).toEqual({
      page: 'title',
      type: 'movie',
      id: 550,
    });
    expect(parseRoute(personHref(287))).toEqual({ page: 'person', id: 287 });
  });

  it('reads anything else as the library', () => {
    for (const other of [
      '',
      '#',
      '#library',
      '#title/person/1',
      '#title/movie/-3',
      '#title/movie/1.5',
      '#person/x',
      '#pair=ABCD',
    ]) {
      expect(parseRoute(other), other).toEqual({ page: 'library' });
    }
  });
});
