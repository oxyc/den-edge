import { describe, expect, it } from 'vitest';
import { appHash, Navigation } from './navigation';

describe('retained routes', () => {
  it('restores Home through nested title/person visits and tab navigation', () => {
    const nav = new Navigation('');
    const home = nav.current;
    nav.save(0, 1840);
    const title = nav.visit('#title/tv/1399');
    expect(title.y).toBe(0);
    nav.save(0, 950);
    nav.visit('#person/287');
    expect(nav.visit('#title/tv/1399')).toBe(title);
    expect(nav.current.y).toBe(950);
    expect(nav.visit('#library')).toBe(home);
    expect(nav.current.y).toBe(1840);
    nav.visit('#settings');
    expect(nav.visit('#library')).toBe(home);
  });
  it('keeps movie, series and title identities separate and starts a new library clean', () => {
    const nav = new Navigation('#movies');
    nav.save(0, 320);
    nav.visit('#series');
    nav.save(0, 780);
    expect(nav.visit('#movies').y).toBe(320);
    expect(nav.visit('#series').y).toBe(780);
    expect(nav.visit('#title/movie/1')).not.toBe(nav.visit('#title/tv/1'));
    expect(new Navigation('#movies').current.y).toBe(0);
  });
});

describe('link interception', () => {
  const base = 'https://den.test/?preview=1#library';
  it('accepts only app routes on the same document', () => {
    for (const hash of ['#library', '#movies', '#series', '#settings', '#title/movie/42', '#person/287']) {
      expect(appHash(hash, base)).toBe(hash);
    }
    for (const href of ['https://other.test/#library', '/api#library', '/?preview=2#library', '#pair=secret', '#section', '#title/tv/0']) {
      expect(appHash(href, base)).toBeNull();
    }
  });
});

describe('history entry ownership', () => {
  it('keeps independent state for separate visits to the same detail URL', () => {
    const nav = new Navigation('#library');
    const first = nav.visit('#title/movie/42', 'entry-1');
    nav.save(0, 1100);
    nav.visit('#person/7', 'entry-2');
    const second = nav.visit('#title/movie/42', 'entry-3');
    expect(second).not.toBe(first);
    expect(second.y).toBe(0);
    nav.save(0, 200);
    expect(nav.visit('#title/movie/42', 'entry-1')).toBe(first);
    expect(nav.current.y).toBe(1100);
    expect(nav.visit('#title/movie/42', 'entry-3').y).toBe(200);
  });
});

it('releases discarded detail branches while retaining reachable visits and tab state', () => {
  const nav = new Navigation('#library');
  const home = nav.current;
  nav.visit('#title/movie/1', 'discarded');
  const kept = nav.visit('#person/7', 'reachable');
  nav.visit('#title/movie/2', 'current');
  nav.prune(new Set(['reachable', 'current']));
  expect(nav.pages.has('discarded')).toBe(false);
  expect(nav.pages.get('reachable')).toBe(kept);
  expect(nav.pages.get('library')).toBe(home);
});
