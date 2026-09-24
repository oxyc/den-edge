import { parseRoute, routePath, type Route } from './route';

export const routeKey = (route: Route): string =>
  route.page === 'title'
    ? `title/${route.type}/${route.id}`
    : route.page === 'person'
      ? `person/${route.id}`
      : route.page === 'service'
        ? `service/${route.id}/${route.country}`
        : route.page;

/**
 * How many title, person and service pages stay mounted besides the one on screen, nearest in history first. Each is
 * a whole live page plus its frozen copy for swipes (`pageSnapshot.ts`), so a long session of Home → title → Home →
 * title kept every one of them until it reloaded.
 */
export const KEPT_DETAILS = 4;

const isDetail = (route: Route) =>
  route.page === 'title' || route.page === 'person' || route.page === 'service';

/** History's page keys, nearest to `position` first, and Back's side first at an equal distance. */
export function nearest(
  entries: ReadonlyMap<number, { pageKey: string }>,
  position: number,
): string[] {
  return [...entries]
    .sort(([a], [b]) => Math.abs(a - position) - Math.abs(b - position) || a - b)
    .map(([, entry]) => entry.pageKey);
}

/** Retained page state: details own a history visit; top-level tabs reuse their browsing surface. */
export interface PageVisit {
  key: string;
  route: Route;
  x: number;
  y: number;
}
export class Navigation {
  readonly pages = new Map<string, PageVisit>();
  current: PageVisit;
  constructor(path: string) {
    this.current = this.visit(path);
  }
  visit(path: string, entryKey?: string): PageVisit {
    const route = parseRoute(path);
    const key = entryKey ?? routeKey(route);
    let page = this.pages.get(key);
    if (!page) {
      page = { key, route, x: 0, y: 0 };
      this.pages.set(key, page);
    } else {
      // Search keeps one surface across every query, so a revisit carries the new one in: the key says
      // which page this is, the route says what it is currently showing, and for every other page the
      // two are the same fact written twice.
      page.route = route;
    }
    return (this.current = page);
  }
  /**
   * Keep tabs as reusable browsing surfaces, and of the detail pages only the `KEPT_DETAILS` nearest in history
   * (`nearest`): one on a discarded branch can't be reached again, and one further back is opened afresh if Back
   * ever reaches it.
   */
  prune(nearby: readonly string[]) {
    const kept = new Set<string>();
    for (const key of nearby) {
      const page = this.pages.get(key);
      if (kept.size >= KEPT_DETAILS) break;
      if (page && page !== this.current && isDetail(page.route)) kept.add(key);
    }
    for (const [key, page] of this.pages) {
      if (page !== this.current && isDetail(page.route) && !kept.has(key)) this.pages.delete(key);
    }
  }
  save(x: number, y: number) {
    this.current.x = x;
    this.current.y = y;
  }
}

/**
 * The app path a link leads to, or null to leave it to the browser: another origin, a download, a new tab —
 * and any link that only moves the fragment, which is how the TV's pairing QR (`#pair=…`) arrives.
 *
 * A path is the app's when it names a page. Home is the exception it has to make room for: `/` is a page, but
 * so is every path the app does not recognise, and those belong to den-edge. `/` with a query is one of those
 * — the e2e fixtures address themselves that way — so only the bare path counts.
 */
export function appPath(href: string, base: string): string | null {
  let url: URL;
  let here: URL;
  try {
    url = new URL(href, base);
    here = new URL(base);
  } catch {
    return null;
  }
  if (url.origin !== here.origin) return null;
  if (url.hash && url.pathname === here.pathname && url.search === here.search) return null;
  const route = parseRoute(url.pathname + url.search);
  const home = url.pathname === '/' && url.search === '';
  return route.page !== 'library' || home ? url.pathname + url.search : null;
}

/** Where a route lives, for callers holding a route rather than a link. */
export { routePath };

/**
 * Used by button-based title selection as well as intercepted anchors.
 *
 * `replace` rewrites the current entry instead of adding one — what typing in the search field wants, since a
 * query that grew a letter at a time would otherwise leave a history entry behind for every keystroke.
 */
export function navigate(path: string, replace = false) {
  document.dispatchEvent(new CustomEvent('den:navigate', { detail: { path, replace } }));
}

/** Navbar and other explicit Back controls use the same scoped router as gestures. */
export function navigateBack() {
  document.dispatchEvent(new Event('den:back'));
}

/**
 * Back past every entry of the current page, to the one before it. Search gives each chip and Movies/Series
 * switch its own entry, so a plain Back from its Cancel walked through every pick one tap at a time before it
 * ever left Search.
 */
export function navigateOut() {
  document.dispatchEvent(new Event('den:back-out'));
}
