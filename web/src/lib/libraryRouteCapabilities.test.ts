import { describe, expect, it } from 'vitest';
import { libraryRouteCapabilities } from './libraryRouteCapabilities';
import type { Route } from './route';

describe('library route capabilities', () => {
  it.each([
    [
      'library',
      { page: 'library' },
      { watchlist: true, recommendations: true, continue: true, devices: true },
    ],
    [
      'movies',
      { page: 'movies' },
      { watchlist: true, recommendations: true, continue: true, devices: true },
    ],
    [
      'series',
      { page: 'series' },
      { watchlist: true, recommendations: true, continue: true, devices: true },
    ],
    [
      'watchlist',
      { page: 'watchlist' },
      { watchlist: true, recommendations: true, continue: true, devices: true },
    ],
    [
      'search',
      { page: 'search', query: 'arrival' },
      { watchlist: true, recommendations: true, continue: false, devices: true },
    ],
    [
      'person',
      { page: 'person', id: 287 },
      { watchlist: true, recommendations: true, continue: false, devices: true },
    ],
    [
      'service',
      { page: 'service', service: 'netflix' },
      { watchlist: true, recommendations: true, continue: false, devices: true },
    ],
    [
      'title',
      { page: 'title', type: 'movie', id: 329865 },
      { watchlist: false, recommendations: false, continue: true, devices: true },
    ],
    [
      'downloads',
      { page: 'downloads' },
      { watchlist: false, recommendations: false, continue: false, devices: false },
    ],
    [
      'people',
      { page: 'people' },
      { watchlist: false, recommendations: false, continue: false, devices: false },
    ],
    [
      'settings',
      { page: 'settings' },
      { watchlist: false, recommendations: false, continue: false, devices: false },
    ],
  ] as const)('%s requests only its render projections', (_name, route, expected) => {
    expect(libraryRouteCapabilities(route as Route)).toEqual(expected);
  });
});
