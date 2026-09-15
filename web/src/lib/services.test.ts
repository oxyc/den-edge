import { describe, expect, it } from 'vitest';
import {
  atlasCatalogs,
  atlasServiceRows,
  GUEST_PICKS,
  mergeServiceRows,
  resolvePicks,
  serviceRows,
  type AtlasCatalog,
} from './services';
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

describe('atlas rows', () => {
  const manifest = {
    catalogs: [
      { type: 'movie', id: 'jw-trending', name: 'Trending Everywhere' },
      { type: 'movie', id: 'jw-nfx', name: 'Popular on Netflix', denProviderIds: [8] },
      { type: 'movie', id: 'jw-nfx-new', name: 'New on Netflix', denProviderIds: [8] },
      { type: 'series', id: 'jw-nfx-leaving', name: 'Leaving Netflix Soon', denProviderIds: [8] },
      { type: 'movie', id: 'jw-prv', name: 'Popular on Prime Video', denProviderIds: [119, 9] },
      { type: 'movie', id: 'den-titles', name: 'Titles' },
    ],
  };
  const answering =
    (body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status: 200 });

  it('reads which services atlas carries from its manifest, not from a list here', async () => {
    const listed = await atlasCatalogs('/atlas', answering(manifest));
    expect(listed.map((c) => c.id)).toEqual(['jw-nfx', 'jw-nfx-new', 'jw-nfx-leaving', 'jw-prv']);
    expect(at(listed, 2).type, 'a series catalog').toBe('tv');
    expect(at(listed, 3).providerIds, 'every id the catalog covers').toEqual([119, 9]);
  });

  it('asks atlas for the service’s own charts, in the country the page is for', async () => {
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ metas: [] }), { status: 200 });
    };
    const listed = await atlasCatalogs('/atlas', answering(manifest));
    const rows = atlasServiceRows('/atlas', listed, service({ id: 8, name: 'Netflix' }), 'FI', {
      fetchImpl,
    });
    expect(
      rows.map((row) => row.title),
      'what just arrived leads',
    ).toEqual(['New on Netflix', 'Popular on Netflix', 'Leaving Netflix Soon']);
    await Promise.all(rows.map((row) => row.load(1)));
    expect(asked).toEqual([
      '/atlas/catalog/movie/jw-nfx-new/country=FI.json',
      '/atlas/catalog/movie/jw-nfx/country=FI.json',
      '/atlas/catalog/series/jw-nfx-leaving/country=FI.json',
    ]);
    // A chart is one page: asking for a second must not repeat the first.
    expect(await at(rows, 0).load(2)).toEqual([]);
    expect(asked).toHaveLength(3);
  });

  it('keeps TMDB’s art where there is any, and atlas’s own where there is not', async () => {
    const metas = {
      metas: [
        {
          id: 'tt1',
          imdb_id: 'tt1',
          moviedb_id: 11,
          name: 'Known',
          type: 'movie',
          posterPath: '/known.jpg',
          poster: 'https://images.metahub.space/poster/medium/tt1/img',
          releaseInfo: '1999',
        },
        {
          id: 'tt2',
          imdb_id: 'tt2',
          moviedb_id: 22,
          name: 'Unmapped',
          type: 'movie',
          poster: 'https://images.metahub.space/poster/medium/tt2/img',
          releaseInfo: '2026',
        },
        { id: 'tt3', name: 'No TMDB id', type: 'movie', poster: 'x', releaseInfo: '2020' },
      ],
    };
    const rows = atlasServiceRows(
      '/atlas',
      [{ id: 'jw-nfx', name: 'Popular on Netflix', type: 'movie', providerIds: [8] }],
      service({ id: 8, name: 'Netflix' }),
      'US',
      { fetchImpl: answering(metas) },
    );
    const titles = await at(rows, 0).load(1);
    expect(
      titles.map((t) => t.id),
      'a title with no TMDB id opens nothing, so it is left out',
    ).toEqual([11, 22]);
    expect(at(titles, 0).posterPath).toBe('/known.jpg');
    expect(at(titles, 1).posterPath).toBeUndefined();
    expect(at(titles, 1).posterUrl).toMatch(/metahub/);
    expect(at(titles, 0).year).toBe(1999);
  });

  it('lets atlas’s charts replace TMDB’s, for the media type it covers and no other', () => {
    const atlas: AtlasCatalog[] = [
      { id: 'jw-nfx', name: 'Popular on Netflix', type: 'movie', providerIds: [8] },
      { id: 'jw-nfx-new', name: 'New on Netflix', type: 'movie', providerIds: [8] },
    ];
    const netflix = service({ id: 8, name: 'Netflix' });
    const own = atlasServiceRows('/atlas', atlas, netflix, 'US');
    const tmdb = serviceRows(netflix, 'US', async () => []);
    const merged = mergeServiceRows(own, tmdb);
    expect(merged.map((row) => row.title)).toEqual([
      'New on Netflix',
      'Popular on Netflix',
      // The films atlas covers lose TMDB's popular and recently-released; series keep theirs, and Acclaimed has no
      // atlas equivalent for either.
      'Recently released Series',
      'Popular Series',
      'Acclaimed Movies',
      'Acclaimed Series',
    ]);
  });

  it('is TMDB’s rows alone where atlas carries nothing for the service', () => {
    const paramount = service({ id: 531, name: 'Paramount+' });
    const tmdb = serviceRows(paramount, 'UY', async () => []);
    const own = atlasServiceRows(
      '/atlas',
      [{ id: 'jw-nfx', name: 'Popular on Netflix', type: 'movie', providerIds: [8] }],
      paramount,
      'UY',
    );
    expect(own).toEqual([]);
    expect(mergeServiceRows(own, tmdb)).toEqual(tmdb);
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
      'Recently released Movies',
      'Recently released Series',
      'Popular Movies',
      'Popular Series',
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
      'Recently released Series',
      'Popular Series',
      'Acclaimed Series',
    ]);
    expect(rows.some((row) => /added/i.test(row.title))).toBe(false);
    await at(rows, 0).load(1);
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
