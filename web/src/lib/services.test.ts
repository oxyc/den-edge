import { describe, expect, it } from 'vitest';
import { GUEST_PICKS, resolvePicks, serviceRows } from './services';
import type { Service } from '../settings/services';
import type { Pages } from './catalog';
import type { Title } from './library';

/** The nth of a list, or a failure that says what was missing rather than a TypeError further down. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (!item) throw new Error(`nothing at ${index}`);
  return item;
}

const service = (over: Partial<Service> & Pick<Service, 'id' | 'name'>): Service => ({
  priority: 1,
  movies: true,
  series: true,
  variants: [],
  ...over,
});

describe('resolvePicks', () => {
  const directory = [
    service({ id: 8, name: 'Netflix', priority: 1, variants: [1796] }),
    service({ id: 337, name: 'Disney Plus', priority: 2 }),
    service({ id: 15, name: 'Hulu', priority: 3 }),
  ];

  it('keeps the directory’s order, whatever order the picks were saved in', () => {
    const picks = [
      { id: 15, country: 'US' },
      { id: 8, country: 'US' },
    ];
    expect(resolvePicks(picks, directory, 'US').map((r) => r.service.name)).toEqual([
      'Netflix',
      'Hulu',
    ]);
  });

  it('resolves a pick saved under a folded variant, and drops what the country cannot account for', () => {
    const picks = [
      { id: 1796, country: 'US' }, // Netflix with ads, folded into 8
      { id: 531, country: 'US' }, // not in this directory
      { id: 8, country: 'FI' }, // another country's shelf
    ];
    const resolved = resolvePicks(picks, directory, 'US');
    expect(resolved.map((r) => r.service.id)).toEqual([8]);
    expect(at(resolved, 0).pick).toEqual({ id: 1796, country: 'US' });
  });

  it('shows a visitor the six US services, when the directory lists them', () => {
    expect(GUEST_PICKS.every((pick) => pick.country === 'US')).toBe(true);
    expect(resolvePicks(GUEST_PICKS, directory, 'US').map((r) => r.service.id)).toEqual([
      8, 337, 15,
    ]);
  });
});

describe('serviceRows', () => {
  /** Records what each row would ask TMDB for, without asking. */
  const asked: { path: string; params: Record<string, string> }[] = [];
  const pages: Pages = async (path, _type, params) => {
    asked.push({ path, params });
    return [] as Title[];
  };

  it('asks for one service’s catalogue in one country, subscriptions only, above a vote floor', async () => {
    asked.length = 0;
    const rows = serviceRows(
      service({ id: 8, name: 'Netflix', variants: [1796] }),
      'FI',
      pages,
      {},
    );
    await Promise.all(rows.map((row) => row.load(1)));

    expect(rows.map((row) => row.title)).toEqual([
      'Popular Movies',
      'Popular Series',
      'Recently released Movies',
      'Recently released Series',
      'Acclaimed Movies',
      'Acclaimed Series',
    ]);
    for (const { params } of asked) {
      expect(params.with_watch_providers, 'every id folded into the service').toBe('8|1796');
      expect(params.watch_region, 'TMDB ignores the provider filter without it').toBe('FI');
      expect(params.with_watch_monetization_types).toBe('flatrate');
    }
    expect(asked.map((a) => a.path)).toEqual([
      '/discover/movie',
      '/discover/tv',
      '/discover/movie',
      '/discover/tv',
      '/discover/movie',
      '/discover/tv',
    ]);
    const acclaimed = asked.filter((a) => a.params.sort_by === 'vote_average.desc');
    expect(acclaimed).toHaveLength(2);
    for (const { params } of acclaimed) expect(params['vote_count.gte']).toBe('300');
    for (const { params } of asked.filter((a) => a.params.sort_by !== 'vote_average.desc'))
      expect(params['vote_count.gte']).toBe('50');
  });

  it('offers only what the service carries, and never claims a release date is an arrival', async () => {
    asked.length = 0;
    const rows = serviceRows(service({ id: 350, name: 'Apple TV+', movies: false }), 'US', pages);
    expect(rows.map((row) => row.title)).toEqual([
      'Popular Series',
      'Recently released Series',
      'Acclaimed Series',
    ]);
    expect(rows.some((row) => /added/i.test(row.title))).toBe(false);
    await at(rows, 1).load(1);
    // TMDB has no date a title landed on a service, so the recent row is by first air date, up to today.
    expect(at(asked, 0).params.sort_by).toBe('first_air_date.desc');
    expect(at(asked, 0).params['first_air_date.lte']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps Settings’ release-year floor', async () => {
    asked.length = 0;
    const rows = serviceRows(service({ id: 8, name: 'Netflix', series: false }), 'US', pages, {
      minYear: 1990,
    });
    await at(rows, 0).load(1);
    expect(at(asked, 0).params['primary_release_date.gte']).toBe('1990-01-01');
  });
});
