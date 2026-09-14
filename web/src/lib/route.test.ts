import { describe, expect, it } from 'vitest';
import {
  legacyPath,
  parseRoute,
  personHref,
  routePath,
  searchHref,
  slug,
  titleHref,
} from './route';

describe('routes', () => {
  it('reads each page from the path', () => {
    expect(parseRoute('/')).toEqual({ page: 'library' });
    expect(parseRoute('/settings')).toEqual({ page: 'settings' });
    expect(parseRoute('/movies')).toEqual({ page: 'movies' });
    expect(parseRoute('/series')).toEqual({ page: 'series' });
    expect(parseRoute('/watchlist')).toEqual({ page: 'watchlist' });
    expect(parseRoute('/tv/1399')).toEqual({ page: 'title', type: 'tv', id: 1399 });
    expect(parseRoute('/movie/550')).toEqual({ page: 'title', type: 'movie', id: 550 });
    expect(parseRoute('/person/287')).toEqual({ page: 'person', id: 287 });
  });

  it('reads a whole href as well as a path, and ignores the fragment', () => {
    expect(parseRoute('https://d.oxy.fi/movie/550')).toEqual({
      page: 'title',
      type: 'movie',
      id: 550,
    });
    expect(parseRoute('/movie/550#pair=ABCD')).toEqual({ page: 'title', type: 'movie', id: 550 });
  });

  it('carries the search query in the URL, so a search can be linked', () => {
    expect(parseRoute('/search')).toEqual({ page: 'search', query: '' });
    expect(parseRoute('/search?q=blade+runner')).toEqual({
      page: 'search',
      query: 'blade runner',
    });
    expect(parseRoute('/search?q=' + encodeURIComponent('amélie'))).toEqual({
      page: 'search',
      query: 'amélie',
    });
    expect(searchHref('blade runner')).toBe('/search?q=blade%20runner');
    expect(searchHref('  ')).toBe('/search');
    expect(parseRoute(searchHref('fight club'))).toEqual({ page: 'search', query: 'fight club' });
  });

  it('names a title in its link without letting the name identify it', () => {
    expect(titleHref({ type: 'movie', id: 550, title: 'Fight Club' })).toBe(
      '/movie/550-fight-club',
    );
    expect(titleHref({ type: 'tv', id: 1399, title: 'Game of Thrones' })).toBe(
      '/tv/1399-game-of-thrones',
    );
    expect(titleHref({ type: 'movie', id: 550 })).toBe('/movie/550');
    expect(personHref(287, 'Brad Pitt')).toBe('/person/287-brad-pitt');
    expect(personHref(287)).toBe('/person/287');
    for (const href of [
      titleHref({ type: 'movie', id: 550, title: 'Fight Club' }),
      titleHref({ type: 'movie', id: 550, title: 'Something Else Entirely' }),
      '/movie/550',
    ]) {
      expect(parseRoute(href)).toEqual({ page: 'title', type: 'movie', id: 550 });
    }
    expect(parseRoute(personHref(287, 'Brad Pitt'))).toEqual({ page: 'person', id: 287 });
  });

  it('builds a slug a link can carry', () => {
    expect(slug('Amélie')).toBe('amelie');
    expect(slug('WALL·E')).toBe('wall-e');
    expect(slug('Mr. & Mrs. Smith')).toBe('mr-mrs-smith');
    expect(slug('   ')).toBe('');
    expect(slug(undefined)).toBe('');
    // Capped, and never left ending mid-word or on a hyphen.
    const long = slug('The Assassination of Jesse James by the Coward Robert Ford');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
    expect(parseRoute(`/movie/2013-${long}`)).toEqual({ page: 'title', type: 'movie', id: 2013 });
  });

  it('reads anything else as the library', () => {
    for (const other of [
      '',
      '/',
      '/library',
      '/title/movie/550',
      '/movie',
      '/movie/-3',
      '/movie/1.5',
      '/movie/0',
      '/person/x',
      '/movies/1',
      '/health',
      '/lib/abc',
    ]) {
      expect(parseRoute(other), other).toEqual({ page: 'library' });
    }
  });

  it('says where a route lives', () => {
    expect(routePath({ page: 'library' })).toBe('/');
    expect(routePath({ page: 'watchlist' })).toBe('/watchlist');
    expect(routePath({ page: 'search', query: 'fight club' })).toBe('/search?q=fight%20club');
    expect(routePath({ page: 'title', type: 'tv', id: 1399 })).toBe('/tv/1399');
    expect(routePath({ page: 'person', id: 287 })).toBe('/person/287');
  });
});

describe('links shared before 0.67.0', () => {
  it('answers an old fragment with the path it meant', () => {
    expect(legacyPath('#library')).toBe('/');
    expect(legacyPath('#movies')).toBe('/movies');
    expect(legacyPath('#watchlist')).toBe('/watchlist');
    expect(legacyPath('#search')).toBe('/search');
    expect(legacyPath('#title/tv/1399')).toBe('/tv/1399');
    expect(legacyPath('#title/movie/550')).toBe('/movie/550');
    expect(legacyPath('#person/287')).toBe('/person/287');
  });

  it('leaves alone anything that was never a route', () => {
    // The pairing code above all: it is read by the pairing screen and must not be rewritten away.
    for (const other of ['', '#', '#pair=ABCD-EFGH', '#section', '#title/person/1', '#person/x']) {
      expect(legacyPath(other), other).toBeNull();
    }
  });
});
