import { describe, expect, it } from 'vitest';
import { named, pageTitle } from './pageTitle';

describe('what the tab says', () => {
  it('names the page from its route', () => {
    expect(pageTitle({ page: 'library' })).toBe('Den');
    expect(pageTitle({ page: 'movies' })).toBe('Movies · Den');
    expect(pageTitle({ page: 'series' })).toBe('Series · Den');
    expect(pageTitle({ page: 'watchlist' })).toBe('Watchlist · Den');
    expect(pageTitle({ page: 'settings' })).toBe('Settings · Den');
  });

  it('carries the search someone typed, so a tab full of searches can be told apart', () => {
    expect(pageTitle({ page: 'search', query: 'blade runner' })).toBe(
      'blade runner · Search · Den',
    );
    expect(pageTitle({ page: 'search', query: '   ' })).toBe('Search · Den');
  });

  it('leaves a title and a person to name themselves once loaded', () => {
    expect(pageTitle({ page: 'title', type: 'movie', id: 550 })).toBe('Den');
    expect(pageTitle({ page: 'person', id: 287 })).toBe('Den');
    expect(named('Fight Club', 1999)).toBe('Fight Club (1999) · Den');
    expect(named('Brad Pitt')).toBe('Brad Pitt · Den');
    // A title that hasn't arrived yet must not leave the tab reading " · Den".
    expect(named('  ')).toBe('Den');
  });
});
