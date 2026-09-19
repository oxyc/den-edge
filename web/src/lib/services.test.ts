import { describe, expect, it } from 'vitest';
import {
  atlasCatalogs,
  atlasServiceRows,
  fillPosters,
  GUEST_PICKS,
  mergeNewRow,
  mergeServiceRows,
  radarRows,
  resolvePicks,
  serviceRows,
  type AtlasCatalog,
} from './services';
import type { Service } from '../settings/services';
import type { Pages, RowDef } from './catalog';
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

const title = (id: number, over: Partial<Title> = {}): Title => ({
  type: 'tv',
  id,
  title: `Title ${id}`,
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
    ).toEqual([
      'New on Netflix · Movies',
      'Popular on Netflix · Movies',
      'Leaving Netflix Soon · Series',
    ]);
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
          imdbRating: '7.8',
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
    expect(at(titles, 0).rating, 'the poster is rated before any detail request').toBe(7.8);
    expect(at(titles, 1).rating, 'legacy/unrated chart entries still decode').toBeUndefined();
  });

  // A chart's art is keyed by IMDb id. TMDB splits an anthology into one show per story where IMDb keeps one, so the
  // art for a series can belong to a different story: Monster's Lizzie Borden entry drew Dahmer's poster.
  it('never falls back to a series’ own art, which can belong to another story', async () => {
    const metas = {
      metas: [
        {
          id: 'tt13207736',
          imdb_id: 'tt13207736',
          moviedb_id: 299939,
          name: 'Monster: The Lizzie Borden Story',
          type: 'series',
          poster: 'https://images.metahub.space/poster/medium/tt13207736/img',
          releaseInfo: '2026',
        },
      ],
    };
    const rows = atlasServiceRows(
      '/atlas',
      [{ id: 'jw-nfx-coming', name: 'Coming to Netflix', type: 'tv', providerIds: [8] }],
      service({ id: 8, name: 'Netflix' }),
      'US',
      { fetchImpl: answering(metas) },
    );
    const titles = await at(rows, 0).load(1);
    expect(at(titles, 0).id).toBe(299939);
    expect(at(titles, 0).posterUrl, 'no art rather than another story’s').toBeUndefined();
  });

  it('lets atlas’s charts replace TMDB’s, for the media type it covers and no other', () => {
    const atlas: AtlasCatalog[] = [
      { id: 'jw-nfx', name: 'Popular on Netflix', type: 'movie', providerIds: [8] },
      { id: 'jw-nfx-new', name: 'New on Netflix', type: 'movie', providerIds: [8] },
    ];
    const netflix = service({ id: 8, name: 'Netflix' });
    const own = atlasServiceRows('/atlas', atlas, netflix, 'US');
    const tmdb = serviceRows(netflix, 'US', async () => []);
    const merged = mergeServiceRows(own, tmdb, new Set(['movie' as const]));
    // The head of the page. The whole catalogue, re-pointed at the service, follows it.
    expect(merged.map((row) => row.title).slice(0, 6)).toEqual([
      'New on Netflix',
      'Popular on Netflix',
      // The films atlas covers lose TMDB's popular and recently-released; series keep theirs, and Acclaimed has no
      // atlas equivalent for either.
      'Recently released Series',
      'Popular Series',
      'Acclaimed Movies',
      'Acclaimed Series',
    ]);
    expect(merged.length, 'and then the service’s own depth').toBeGreaterThan(50);
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
    expect(mergeServiceRows(own, tmdb, new Set())).toEqual(tmdb);
  });

  it('replaces a TMDB row only once atlas has answered for that type', () => {
    const netflix = service({ id: 8, name: 'Netflix' });
    const own = atlasServiceRows(
      '/atlas',
      [{ id: 'jw-nfx', name: 'Popular on Netflix', type: 'movie', providerIds: [8] }],
      netflix,
      'US',
    );
    const tmdb = serviceRows(netflix, 'US', async () => []);
    // Listed but not yet answered: every TMDB row stands, so the page is never down to Acclaimed alone.
    expect(
      mergeServiceRows(own, tmdb, new Set())
        .map((row) => row.title)
        .slice(0, 7),
    ).toEqual([
      'Popular on Netflix',
      'Recently released Movies',
      'Recently released Series',
      'Popular Movies',
      'Popular Series',
      'Acclaimed Movies',
      'Acclaimed Series',
    ]);
  });
});

describe('fillPosters', () => {
  it('names art for the head of a chart, by TMDB id, and asks nothing for the rest', async () => {
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      asked.push(String(url).replace(/\?.*/, ''));
      return new Response(JSON.stringify({ poster_path: '/found.jpg' }), { status: 200 });
    };
    const titles = Array.from({ length: 20 }, (_, i) => title(i + 1));
    const filled = await fillPosters(titles, 'k', { head: 3, atOnce: 2, fetchImpl });
    expect(asked).toEqual([
      'https://api.themoviedb.org/3/tv/1',
      'https://api.themoviedb.org/3/tv/2',
      'https://api.themoviedb.org/3/tv/3',
    ]);
    expect(filled.slice(0, 3).map((t) => t.posterPath)).toEqual([
      '/found.jpg',
      '/found.jpg',
      '/found.jpg',
    ]);
    expect(at(filled, 3).posterPath, 'the tail keeps its placeholder').toBeUndefined();
  });

  it('asks even for a title a chart gave art, and keeps what it had when TMDB cannot name it', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response('{}', { status: 404 });
    };
    // TMDB's own path is art and is left alone.
    const named = [title(1, { posterPath: '/a.jpg' })];
    expect(await fillPosters(named, 'k', { fetchImpl })).toEqual(named);
    expect(calls).toBe(0);

    // A chart's own art is metahub's, which the page can only draw if its CSP allows the host metahub
    // redirects to — so it is asked for anyway, and TMDB's path wins wherever there is one.
    const chartArt = [title(2, { posterUrl: 'https://art/b.jpg' })];
    expect(
      await fillPosters(chartArt, 'k', { fetchImpl }),
      'and keeps it when TMDB has none',
    ).toEqual(chartArt);
    expect(calls).toBe(1);

    const unnamed = [title(3)];
    expect(await fillPosters(unnamed, 'k', { fetchImpl })).toEqual(unnamed);
    expect(calls).toBe(2);
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
    // The three sorts per type that lead the page; the catalogue's own rows follow, and are checked below.
    const head = rows.slice(0, 6);
    await Promise.all(head.map((row) => row.load(1)));

    expect(head.map((row) => row.title)).toEqual([
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

    // And then the catalogue itself, re-pointed at the service: depth is what the service has, not a page of
    // three sorts — and every one of those rows asks with the provider filter too, or it would be a row about
    // everything wearing this service's name.
    expect(rows.length, 'as deep as the service is').toBeGreaterThan(50);
    asked.length = 0;
    await at(rows, 20).load(1);
    expect(at(asked, 0).params.with_watch_providers).toBe('8|1796');
    expect(at(asked, 0).params.watch_region).toBe('FI');
    expect(at(asked, 0).params.with_watch_monetization_types).toBe('flatrate');
  });

  it('offers only what the service carries, and never claims a release date is an arrival', async () => {
    asked.length = 0;
    const rows = serviceRows(service({ id: 350, name: 'Apple TV+', movies: false }), 'US', pages);
    expect(rows.map((row) => row.title).slice(0, 3)).toEqual([
      'Recently released Series',
      'Popular Series',
      'Acclaimed Series',
    ]);
    // A service with no films offers none anywhere on the page — in the feed below the head either.
    expect(rows.some((row) => / Movies$/.test(row.title))).toBe(false);
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

describe('radarRows', () => {
  const catalogs: AtlasCatalog[] = [
    { id: 'jw-nfx-new', name: 'New on Netflix', type: 'movie', providerIds: [8] },
    { id: 'jw-mxx-new', name: 'New on Max', type: 'movie', providerIds: [1899] },
    { id: 'jw-nfx-coming', name: 'Coming to Netflix', type: 'tv', providerIds: [8] },
    { id: 'jw-nfx', name: 'Popular on Netflix', type: 'movie', providerIds: [8] },
  ];
  const picks = [
    { id: 8, country: 'US' },
    { id: 1899, country: 'US' },
  ];
  const names = { 8: 'Netflix', 1899: 'Max' };
  const meta = (id: number, over: Record<string, unknown> = {}) => ({
    id: `tt${id}`,
    imdb_id: `tt${id}`,
    moviedb_id: id,
    name: `Title ${id}`,
    type: 'movie',
    posterPath: `/${id}.jpg`,
    ...over,
  });
  /** Answers each chart with whatever the test maps its id to, and records what was asked. */
  const serving =
    (charts: Record<string, unknown[]>, asked: string[] = []): typeof fetch =>
    async (url) => {
      const href = String(url);
      asked.push(href);
      const id = Object.keys(charts).find((name) => href.includes(name));
      return new Response(JSON.stringify({ metas: id ? charts[id] : [] }), { status: 200 });
    };

  it('pools every service’s chart of a kind into one row, and asks each chart once', async () => {
    const asked: string[] = [];
    const fetchImpl = serving({ 'jw-nfx-new': [meta(1)], 'jw-mxx-new': [meta(2)] }, asked);
    const rows = radarRows('/atlas', catalogs, picks, { names, fetchImpl });
    expect(rows.map((row) => row.title)).toEqual(['New Releases', 'Coming Soon']);

    const titles = await at(rows, 0).load(1);
    expect(asked).toEqual([
      '/atlas/catalog/movie/jw-nfx-new/country=US.json',
      '/atlas/catalog/movie/jw-mxx-new/country=US.json',
    ]);
    expect(
      titles.map((t) => t.id),
      'a turn each, so neither service owns the head',
    ).toEqual([1, 2]);
    expect(at(rows, 0).caption?.(at(titles, 0))).toBe('Netflix');
    // A chart is one page: asking for a second must not repeat the first.
    expect(await at(rows, 0).load(2)).toEqual([]);
    expect(asked).toHaveLength(2);
  });

  it('names a title both services carry once, and says both', async () => {
    const shared = meta(7);
    const fetchImpl = serving({ 'jw-nfx-new': [shared], 'jw-mxx-new': [shared] });
    const rows = radarRows('/atlas', catalogs, picks, { names, fetchImpl });
    const titles = await at(rows, 0).load(1);
    expect(titles.map((t) => t.id)).toEqual([7]);
    expect(at(rows, 0).caption?.(at(titles, 0))).toBe('Netflix · Max');
  });

  it('leads with what lands soonest, and leaves what carries no date in the charts’ order', async () => {
    const day = 86_400_000;
    const soon = Date.now() + day;
    const later = Date.now() + 30 * day;
    const fetchImpl = serving({
      'jw-nfx-coming': [
        meta(1, { type: 'series' }),
        meta(2, { type: 'series', denAt: Math.floor(later / 1000) }),
        meta(3, { type: 'series', denAt: Math.floor(soon / 1000) }),
      ],
    });
    const rows = radarRows('/atlas', catalogs, picks, { names, fetchImpl });
    const titles = await at(rows, 1).load(1);
    expect(
      titles.map((t) => t.id),
      'dated first, soonest of them leading; the undated keeps its place behind them',
    ).toEqual([3, 2, 1]);
    expect(at(titles, 0).arrivesAt).toBe(Math.floor(soon / 1000) * 1000);
    // The caption of a row about what is still to come says when, as well as where.
    expect(at(rows, 1).caption?.(at(titles, 0))).toMatch(/^Netflix · /);
    expect(at(rows, 1).caption?.(at(titles, 2)), 'nothing to say beyond the service').toBe(
      'Netflix',
    );
  });

  it('leads New Releases with what just landed, and pages on with TMDB alone', async () => {
    const fetchImpl = serving({ 'jw-nfx-new': [meta(1)], 'jw-mxx-new': [meta(2)] });
    const arrivals = at(radarRows('/atlas', catalogs, picks, { names, fetchImpl }), 0);
    const asked: number[] = [];
    const releases: RowDef = {
      id: 'new-releases',
      title: 'New Releases',
      load: async (page) => {
        asked.push(page);
        // TMDB's first page repeats a title the charts already named — the same media type and id, which is
        // what makes it the same title — and offers one they did not.
        return page === 1
          ? [title(1, { type: 'movie', year: 2026 }), title(9, { type: 'movie', year: 2026 })]
          : [title(10 * page, { type: 'movie', year: 2026 })];
      },
    };
    const merged = mergeNewRow(arrivals, releases);
    expect(merged.title).toBe('New Releases');

    const first = await merged.load(1);
    expect(
      first.map((t) => t.id),
      'the arrivals lead, and what TMDB repeats is not shown twice',
    ).toEqual([1, 2, 9]);
    expect(merged.caption?.(at(first, 0)), 'a chart title says where it landed').toBe('Netflix');
    expect(merged.caption?.(at(first, 2)), 'a TMDB title keeps its year').toBe('2026');

    expect((await merged.load(2)).map((t) => t.id)).toEqual([20]);
    expect(asked, 'the charts are one page; past it the row is TMDB alone').toEqual([1, 2]);
  });

  it('keeps New Releases whole when atlas cannot answer', async () => {
    const failing: typeof fetch = async () => new Response('nope', { status: 502 });
    const arrivals = at(radarRows('/atlas', catalogs, picks, { names, fetchImpl: failing }), 0);
    const releases: RowDef = {
      id: 'new-releases',
      title: 'New Releases',
      load: async () => [title(9, { type: 'movie', year: 2026 })],
    };
    expect((await mergeNewRow(arrivals, releases).load(1)).map((t) => t.id)).toEqual([9]);
  });

  it('builds no row for a kind atlas has no chart of, and none at all without a pick it covers', () => {
    const onlyPopular = catalogs.filter((c) => !c.id.includes('-new') && !c.id.includes('-coming'));
    expect(radarRows('/atlas', onlyPopular, picks)).toEqual([]);
    expect(radarRows('/atlas', catalogs, [{ id: 337, country: 'US' }]).map((r) => r.title)).toEqual(
      [],
    );
    // A screen showing one media type only pools the charts of that type.
    expect(radarRows('/atlas', catalogs, picks, { only: 'tv' }).map((r) => r.title)).toEqual([
      'Coming Soon',
    ]);
  });
});
