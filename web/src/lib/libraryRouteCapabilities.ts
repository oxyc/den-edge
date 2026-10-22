import type { Route } from './route';

export interface LibraryRouteCapabilities {
  /** Saved titles used by Home and poster actions on discovery surfaces. */
  watchlist: boolean;
  /** Compact taste, ownership and watched inputs used by discovery surfaces. */
  recommendations: boolean;
  /** Resume state used by Home shelves, Watchlist and playback. */
  continue: boolean;
  /** Household TV receivers offered by title actions. */
  devices: boolean;
}

/** The encrypted library projections one active route needs; provider discovery remains session-scoped. */
export function libraryRouteCapabilities(route: Route): LibraryRouteCapabilities {
  switch (route.page) {
    case 'downloads':
    case 'people':
      return { watchlist: false, recommendations: false, continue: false, devices: false };
    case 'title':
      return { watchlist: false, recommendations: false, continue: true, devices: true };
    case 'library':
    case 'movies':
    case 'series':
    case 'watchlist':
      return { watchlist: true, recommendations: true, continue: true, devices: true };
    case 'search':
    case 'person':
    case 'service':
      return { watchlist: true, recommendations: true, continue: false, devices: true };
    case 'settings':
      // RoutedLibrary owns Settings and does not mount Library, but keep the exhaustive boundary explicit.
      return { watchlist: false, recommendations: false, continue: false, devices: false };
  }
}
