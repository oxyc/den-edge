import { parseRoute, type Route } from './route';

export const routeKey = (route: Route): string =>
  route.page === 'title'
    ? `title/${route.type}/${route.id}`
    : route.page === 'person'
      ? `person/${route.id}`
      : route.page;

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
  constructor(hash: string) {
    this.current = this.visit(hash);
  }
  visit(hash: string, entryKey?: string): PageVisit {
    const route = parseRoute(hash);
    const key = entryKey ?? routeKey(route);
    let page = this.pages.get(key);
    if (!page) {
      page = { key, route, x: 0, y: 0 };
      this.pages.set(key, page);
    }
    return (this.current = page);
  }
  /** Discarded browser branches cannot be reached again. Keep tabs as reusable browsing surfaces. */
  prune(retained: ReadonlySet<string>) {
    for (const [key, page] of this.pages) {
      if (
        page !== this.current &&
        !retained.has(key) &&
        (page.route.page === 'title' || page.route.page === 'person')
      ) {
        this.pages.delete(key);
      }
    }
  }
  save(x: number, y: number) {
    this.current.x = x;
    this.current.y = y;
  }
}

/** Leave external links, downloads, new tabs and pairing fragments to the browser. */
export function appHash(href: string, base: string): string | null {
  const url = new URL(href, base);
  const here = new URL(base);
  if (url.origin !== here.origin || url.pathname !== here.pathname || url.search !== here.search)
    return null;
  return /^#(?:library|movies|series|settings|search|title\/(?:movie|tv)\/[1-9]\d*|person\/[1-9]\d*)$/.test(
    url.hash,
  )
    ? url.hash
    : null;
}

/** Used by button-based title selection as well as intercepted anchors. */
export function navigate(hash: string) {
  document.dispatchEvent(new CustomEvent('den:navigate', { detail: hash }));
}

/** Navbar and other explicit Back controls use the same scoped router as gestures. */
export function navigateBack() {
  document.dispatchEvent(new Event('den:back'));
}
