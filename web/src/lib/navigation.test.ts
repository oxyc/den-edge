import { describe, expect, it } from 'vitest';
import { appPath, KEPT_DETAILS, Navigation, nearest } from './navigation';

describe('retained routes', () => {
  it('restores Home through nested title/person visits and tab navigation', () => {
    const nav = new Navigation('/');
    const home = nav.current;
    nav.save(0, 1840);
    const title = nav.visit('/tv/1399');
    expect(title.y).toBe(0);
    nav.save(0, 950);
    nav.visit('/person/287');
    expect(nav.visit('/tv/1399')).toBe(title);
    expect(nav.current.y).toBe(950);
    expect(nav.visit('/')).toBe(home);
    expect(nav.current.y).toBe(1840);
    nav.visit('/settings');
    expect(nav.visit('/')).toBe(home);
  });
  it('keeps movie, series and title identities separate and starts a new library clean', () => {
    const nav = new Navigation('/movies');
    nav.save(0, 320);
    nav.visit('/series');
    nav.save(0, 780);
    expect(nav.visit('/movies').y).toBe(320);
    expect(nav.visit('/series').y).toBe(780);
    expect(nav.visit('/movie/1')).not.toBe(nav.visit('/tv/1'));
    expect(new Navigation('/movies').current.y).toBe(0);
  });
  it('keeps one search surface across queries, showing the latest', () => {
    const nav = new Navigation('/search?q=fight');
    const search = nav.current;
    nav.save(0, 640);
    const again = nav.visit('/search?q=fight+club');
    expect(again).toBe(search);
    expect(again.y).toBe(640);
    expect(again.route).toEqual({ page: 'search', query: 'fight club' });
  });
});

describe('link interception', () => {
  const base = 'https://den.test/';
  it('accepts only app routes on the same document', () => {
    for (const href of [
      '/',
      '/movies',
      '/series',
      '/watchlist',
      '/settings',
      '/search',
      '/search?q=blade+runner',
      '/movie/42',
      '/movie/550-fight-club',
      '/person/287',
    ]) {
      expect(appPath(href, base), href).toBe(href);
    }
    for (const href of [
      'https://other.test/movies',
      '/api',
      '/lib/abc',
      '/movie/0',
      // The fixtures address themselves with a query on Home, and den-edge owns every other path.
      '/?preview=2',
      // Fragment-only links stay the browser's: this is how the TV's pairing code arrives.
      '#pair=secret',
      '#section',
    ]) {
      expect(appPath(href, base), href).toBeNull();
    }
  });

  it('follows a link that carries a fragment to another page', () => {
    expect(appPath('/movie/550#cast', base)).toBe('/movie/550');
  });
});

describe('history entry ownership', () => {
  it('keeps search separate from Home and restores both through detail visits', () => {
    const nav = new Navigation('/');
    const home = nav.current;
    nav.save(0, 950);
    const search = nav.visit('/search');
    nav.save(0, 520);
    nav.visit('/movie/42', 'result');
    expect(nav.visit('/search')).toBe(search);
    expect(nav.current.y).toBe(520);
    expect(nav.visit('/')).toBe(home);
    expect(nav.current.y).toBe(950);
  });
  it('keeps independent state for separate visits to the same detail URL', () => {
    const nav = new Navigation('/');
    const first = nav.visit('/movie/42', 'entry-1');
    nav.save(0, 1100);
    nav.visit('/person/7', 'entry-2');
    const second = nav.visit('/movie/42', 'entry-3');
    expect(second).not.toBe(first);
    expect(second.y).toBe(0);
    nav.save(0, 200);
    expect(nav.visit('/movie/42', 'entry-1')).toBe(first);
    expect(nav.current.y).toBe(1100);
    expect(nav.visit('/movie/42', 'entry-3').y).toBe(200);
  });
});

it('releases discarded detail branches while retaining reachable visits and tab state', () => {
  const nav = new Navigation('/');
  const home = nav.current;
  nav.visit('/movie/1', 'discarded');
  const kept = nav.visit('/person/7', 'reachable');
  nav.visit('/movie/2', 'current');
  nav.prune(['current', 'reachable']);
  expect(nav.pages.has('discarded')).toBe(false);
  expect(nav.pages.get('reachable')).toBe(kept);
  expect(nav.pages.get('library')).toBe(home);
});

describe('kept pages', () => {
  it('keeps only the detail pages nearest in history, and every tab', () => {
    const nav = new Navigation('/');
    const entries = new Map<number, { pageKey: string }>([[0, { pageKey: 'library' }]]);
    // Home → title → Home → title …, as the router records it: each title visit its own page.
    for (let i = 1; i <= 8; i++) {
      nav.visit('/', 'library');
      entries.set(2 * i - 1, { pageKey: 'library' });
      nav.visit(`/movie/${i}`, `visit-${i}`);
      entries.set(2 * i, { pageKey: `visit-${i}` });
      nav.prune(nearest(entries, 2 * i));
    }
    nav.visit('/settings');
    entries.set(17, { pageKey: 'settings' });
    nav.prune(nearest(entries, 17));
    expect([...nav.pages.keys()].sort()).toEqual(
      ['library', 'settings', 'visit-5', 'visit-6', 'visit-7', 'visit-8'].sort(),
    );
    // Settings, left, is kept too: a pairing it is hosting goes on while another page is open.
    nav.visit('/', 'library');
    entries.set(18, { pageKey: 'library' });
    nav.prune(nearest(entries, 18));
    expect(nav.pages.has('settings')).toBe(true);
    expect(KEPT_DETAILS).toBe(4);
  });

  it('keeps the entries either side of the current one first', () => {
    const entries = new Map([0, 1, 2, 3, 4].map((at) => [at, { pageKey: `p${at}` }]));
    expect(nearest(entries, 2)).toEqual(['p2', 'p1', 'p3', 'p0', 'p4']);
  });
});
