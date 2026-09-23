import { describe, expect, it } from 'vitest';
import {
  legacyPath,
  likeId,
  likeOf,
  parseRoute,
  personHref,
  routePath,
  searchHref,
  serviceHref,
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
    expect(parseRoute('/service/8-us')).toEqual({ page: 'service', id: 8, country: 'US' });
  });

  it('carries a service’s country in its path, since a catalogue is licensed per country', () => {
    expect(parseRoute('/service/8-us-netflix')).toEqual({ page: 'service', id: 8, country: 'US' });
    expect(parseRoute('/service/8-FI')).toEqual({ page: 'service', id: 8, country: 'FI' });
    expect(serviceHref(8, 'US', 'Netflix')).toBe('/service/8-us-netflix');
    expect(serviceHref(1899, 'FI')).toBe('/service/1899-fi');
    expect(parseRoute(serviceHref(337, 'US', 'Disney Plus'))).toEqual({
      page: 'service',
      id: 337,
      country: 'US',
    });
    expect(routePath({ page: 'service', id: 8, country: 'US' })).toBe('/service/8-us');
    for (const path of ['/service/8', '/service/us-8', '/service/8-usa', '/service/0-us'])
      expect(parseRoute(path), path).toEqual({ page: 'library' });
  });

  // `warmOnIntent` resolves a trailer for every press whose href parses as a title. A service href has the shape of
  // a title's `<id>-<slug>` segment, so if it ever read as one, every press on a tile would ask reel to resolve a
  // trailer for a title id that does not exist — and nothing on screen would show it.
  it('never reads a service href as a title', () => {
    for (const href of [
      serviceHref(8, 'US', 'Netflix'),
      serviceHref(1899, 'US', 'Max'),
      serviceHref(337, 'FI'),
    ])
      expect(parseRoute(href).page, href).toBe('service');
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

  it('carries what Explore is browsing beside the query, and drops what it cannot read', () => {
    expect(parseRoute('/search?type=tv&c=genre-10765')).toStrictEqual({
      page: 'search',
      query: '',
      type: 'tv',
      chips: ['genre-10765'],
    });
    // An unknown type is the default one, not a third kind of search.
    expect(parseRoute('/search?type=person&c=')).toStrictEqual({ page: 'search', query: '' });
    expect(searchHref('', { type: 'tv', chips: ['recipe-heist'] })).toBe(
      '/search?type=tv&c=recipe-heist',
    );
    expect(searchHref('heist', { chips: ['genre-28'] })).toBe('/search?q=heist&c=genre-28');
    // Clearing the query keeps the Explore view it was typed over.
    const typed = parseRoute('/search?q=heist&type=tv&c=genre-80');
    if (typed.page !== 'search') throw new Error('not a search');
    expect(parseRoute(searchHref('', typed))).toStrictEqual({
      page: 'search',
      query: '',
      type: 'tv',
      chips: ['genre-80'],
    });
    expect(routePath(typed)).toBe('/search?q=heist&type=tv&c=genre-80');
  });

  it('reads no type as All, and writes All as no type, so a bare /search is films and series together', () => {
    expect(parseRoute('/search')).toStrictEqual({ page: 'search', query: '' });
    expect(searchHref('', {})).toBe('/search');
    expect(searchHref('', { chips: ['genre-28'] })).toBe('/search?c=genre-28');
    // Movies is a choice like Series now, so it is written out.
    for (const type of ['movie', 'tv'] as const) {
      const href = searchHref('', { type, chips: ['genre-35'] });
      expect(href).toBe(`/search?type=${type}&c=genre-35`);
      expect(parseRoute(href)).toStrictEqual({
        page: 'search',
        query: '',
        type,
        chips: ['genre-35'],
      });
    }
  });

  it('carries several facets in the order picked, readable as written and each once', () => {
    const href = searchHref('', { chips: ['country-SE', 'genre-28'] });
    expect(href).toBe('/search?c=country-SE,genre-28');
    expect(parseRoute(href)).toStrictEqual({
      page: 'search',
      query: '',
      chips: ['country-SE', 'genre-28'],
    });
    // A comma the browser escaped reads the same; a repeat and anything unreadable are dropped.
    expect(parseRoute('/search?c=country-SE%2Cgenre-28,genre-28,<b>,')).toStrictEqual({
      page: 'search',
      query: '',
      chips: ['country-SE', 'genre-28'],
    });
  });

  it('carries a "Like" and a rating floor as facets like any other', () => {
    const href = searchHref('', {
      type: 'tv',
      chips: [likeId({ type: 'tv', id: 1396 }), 'rating-7'],
    });
    expect(href).toBe('/search?type=tv&c=like-tv-1396,rating-7');
    expect(parseRoute(href)).toStrictEqual({
      page: 'search',
      query: '',
      type: 'tv',
      chips: ['like-tv-1396', 'rating-7'],
    });
    expect(likeOf('like-tv-1396')).toEqual({ type: 'tv', id: 1396 });
    expect(likeOf('like-person-1')).toBeUndefined();
    expect(likeOf('mood-cozy')).toBeUndefined();
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
