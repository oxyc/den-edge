// What the browser tab, a bookmark and a history entry call the page.
//
// Every page said "Den", because nothing ever set `document.title`. That is fine for an app you keep in one
// tab and nowhere else: a second tab, a bookmark made months ago, and the history menu all read the same word,
// and the one place a title is worth having is exactly where someone is looking for the page again.
//
// A title's, a person's and a service's page are named by the page itself (`named`, `nameTab`), once it knows
// what it is showing.

import type { Route } from './route';

const SITE = 'Den';

/** The page's name from its route alone. A title and a person keep the site name until their page loads. */
export function pageTitle(route: Route): string {
  switch (route.page) {
    case 'movies':
      return `Movies · ${SITE}`;
    case 'series':
      return `Series · ${SITE}`;
    case 'watchlist':
      return `Watchlist · ${SITE}`;
    case 'settings':
      return `Settings · ${SITE}`;
    case 'search':
      return route.query.trim() ? `${route.query.trim()} · Search · ${SITE}` : `Search · ${SITE}`;
    case 'people':
      return `People · ${SITE}`;
    // Until the directory names it: the page calls itself "Netflix · Den" through `named` once it knows.
    case 'service':
      return `Service · ${SITE}`;
    default:
      return SITE;
  }
}

/** A loaded page's own name: "Fight Club (1999) · Den". */
export function named(name: string, year?: number): string {
  const trimmed = name.trim();
  if (!trimmed) return SITE;
  return year ? `${trimmed} (${year}) · ${SITE}` : `${trimmed} · ${SITE}`;
}
