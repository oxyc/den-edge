// The streaming-service screens, as the TV has them (ServiceRow on Home, ServiceChannelView behind a tile): which
// services a viewer is shown, and what one of them carries.
//
// A service is picked per country, because a catalogue is licensed per country — Netflix US and Netflix FI hold
// different films — so every query here names the country, and TMDB's availability is JustWatch's data, which is why
// both surfaces carry its credit.

import { discoverParams, type DiscoverQuery, type Pages, type RowDef } from './catalog';
import type { MediaType, Title } from './library';
import type { ServicePick } from './prefs';
import { relayFetch } from './relayFetch';
import { matches, type Service } from '../settings/services';

/**
 * What a visitor with no library sees: the six US services, in TMDB's own US order.
 *
 * Ids are JustWatch's, the same everywhere; the name and the logo are not here, they come from TMDB's directory for
 * the country. A pick the directory does not list simply has no tile, which is what makes this list safe to state.
 */
export const GUEST_PICKS: readonly ServicePick[] = [
  { id: 8, country: 'US' }, // Netflix
  { id: 1899, country: 'US' }, // Max
  { id: 15, country: 'US' }, // Hulu
  { id: 337, country: 'US' }, // Disney+
  { id: 350, country: 'US' }, // Apple TV+
  { id: 531, country: 'US' }, // Paramount+
];

/** A pick resolved against its country's directory: the tile's name and logo, and the ids its rows ask for. */
export interface ResolvedService {
  pick: ServicePick;
  service: Service;
}

/**
 * The picks a country's directory can account for, in the directory's own order.
 *
 * TMDB re-prioritises variants ("Netflix Standard with Ads" and Netflix are two ids), so a pick saved last month can
 * name one that is no longer the primary — `matches` is what keeps it resolvable. A pick nothing accounts for is
 * dropped rather than drawn as an unnamed tile.
 */
export function resolvePicks(
  picks: readonly ServicePick[],
  directory: readonly Service[],
  country: string,
): ResolvedService[] {
  const here = picks.filter((pick) => pick.country === country);
  return directory.flatMap((service) => {
    const pick = here.find((p) => matches(service, p.id));
    return pick ? [{ pick, service }] : [];
  });
}

/** One of atlas's catalogs, as its manifest declares it: which service it is about, and what it is called. */
export interface AtlasCatalog {
  id: string;
  name: string;
  type: MediaType;
  /** Every provider id the catalog covers (`denProviderIds`), including the ones TMDB folds into one service. */
  providerIds: number[];
}

/**
 * atlas's own catalogs for services, read from its manifest rather than named here.
 *
 * The ids are atlas's (`jw-nfx`, `jw-nfx-new`), and which services it carries changes with its releases — so the
 * manifest is what says whether a service has rows at all, and what they are called.
 */
export async function atlasCatalogs(
  base: string,
  fetchImpl: typeof fetch = relayFetch,
): Promise<AtlasCatalog[]> {
  const res = await fetchImpl(`${base}/manifest.json`);
  if (!res.ok) throw new Error(`atlas answered ${res.status}`);
  const body = (await res.json()) as { catalogs?: unknown };
  const catalogs = Array.isArray(body.catalogs) ? body.catalogs : [];
  return catalogs.flatMap((raw): AtlasCatalog[] => {
    const entry = raw as Record<string, unknown>;
    const ids = Array.isArray(entry.denProviderIds)
      ? entry.denProviderIds.filter((id): id is number => typeof id === 'number')
      : [];
    const type = entry.type === 'series' ? 'tv' : entry.type === 'movie' ? 'movie' : null;
    if (!ids.length || !type || typeof entry.id !== 'string' || typeof entry.name !== 'string')
      return [];
    return [{ id: entry.id, name: entry.name, type, providerIds: ids }];
  });
}

/** One of atlas's catalog answers as titles: Stremio metas, which name TMDB's id and carry art of their own. */
function titlesOfMetas(body: unknown): Title[] {
  const metas = (body as { metas?: unknown } | null)?.metas;
  if (!Array.isArray(metas)) return [];
  return (metas as Record<string, unknown>[]).flatMap((meta): Title[] => {
    const type = meta.type === 'series' ? 'tv' : meta.type === 'movie' ? 'movie' : null;
    const id = meta.moviedb_id;
    // Without TMDB's id there is no page to open and no way to match what the library holds, so the title is left out
    // rather than drawn as a card that leads nowhere.
    if (!type || typeof id !== 'number' || typeof meta.name !== 'string') return [];
    const year = Number(String(meta.releaseInfo ?? '').slice(0, 4));
    return [
      {
        type,
        id,
        title: meta.name,
        posterPath: typeof meta.posterPath === 'string' ? meta.posterPath : undefined,
        posterUrl: typeof meta.poster === 'string' ? meta.poster : undefined,
        year: Number.isInteger(year) && year > 1800 ? year : undefined,
        imdbId: typeof meta.imdb_id === 'string' ? meta.imdb_id : undefined,
      },
    ];
  });
}

/**
 * A service's rows from atlas: what is popular on it, what is new, what is leaving and what is coming — the last three
 * being facts TMDB does not carry at all.
 *
 * One request each, and one page: these are charts, not a catalogue to page through, so a second page is empty.
 */
export function atlasServiceRows(
  base: string,
  catalogs: readonly AtlasCatalog[],
  service: Service,
  country: string,
  { only, fetchImpl = relayFetch }: { only?: MediaType; fetchImpl?: typeof fetch } = {},
): RowDef[] {
  const ids = new Set([service.id, ...service.variants]);
  // What has just arrived leads, as it does in the TMDB rows: then what is popular, then what is about to go or
  // about to land. atlas's manifest lists them popular-first, which is its own order and not this page's.
  const rank = (id: string) =>
    id.endsWith('-new') ? 0 : id.endsWith('-leaving') ? 2 : id.endsWith('-coming') ? 3 : 1;
  return catalogs
    .filter((c) => (only ? c.type === only : true) && c.providerIds.some((id) => ids.has(id)))
    .slice()
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((catalog) => ({
      id: `service-atlas-${service.id}-${country}-${catalog.id}-${catalog.type}`,
      title: catalog.name,
      load: async (page: number) => {
        if (page > 1) return [];
        const path = catalog.type === 'tv' ? 'series' : 'movie';
        const res = await fetchImpl(
          `${base}/catalog/${path}/${catalog.id}/country=${encodeURIComponent(country)}.json`,
        );
        if (!res.ok) throw new Error(`atlas answered ${res.status}`);
        return titlesOfMetas(await res.json());
      },
    }));
}

/**
 * A service's page: atlas's rows where it has them, and TMDB's for what atlas does not do.
 *
 * Where atlas covers a service, its charts replace TMDB's popular and recently-released rows for that media type —
 * two rows about the same thing from two sources, with different titles in them, is worse than either alone, and
 * atlas's "New on …" is a real arrivals list where TMDB's is a release date standing in for one. Acclaimed has no
 * atlas equivalent and always comes from TMDB.
 */
export function mergeServiceRows(atlas: readonly RowDef[], tmdb: readonly RowDef[]): RowDef[] {
  const covered = new Set(atlas.map((row) => row.id.slice(row.id.lastIndexOf('-') + 1)));
  const superseded = (row: RowDef) =>
    covered.has(row.id.slice(row.id.lastIndexOf('-') + 1)) &&
    (row.id.includes('-popular-') || row.id.includes('-new-'));
  return [...atlas, ...tmdb.filter((row) => !superseded(row))];
}

/** Subscription only. TMDB leaks rent and buy through this filter even so, which the vote floors below cover for. */
const FLATRATE = ['flatrate'];

/**
 * The floor under every row. A bare provider filter is most of a catalogue, and most of a catalogue is unrated
 * filler; `acclaimed` needs a harder one, since an average over a handful of votes says nothing.
 */
const VOTES = 50;
const ACCLAIMED_VOTES = 300;

const NOUN: Record<MediaType, string> = { movie: 'Movies', tv: 'Series' };

/**
 * The sorts a service's own rows are, per media type it carries, newest first: what a subscriber opens a service for
 * is what has just turned up, and its popular titles are the ones they are likeliest to have seen already.
 */
const SORTS = [
  // TMDB has no "added to the service" date and no sort for one, so this is the release date and must never claim
  // otherwise: "Recently released", never "Recently added".
  { id: 'new', title: 'Recently released', sortBy: '', votes: VOTES },
  { id: 'popular', title: 'Popular', sortBy: 'popularity.desc', votes: VOTES },
  { id: 'acclaimed', title: 'Acclaimed', sortBy: 'vote_average.desc', votes: ACCLAIMED_VOTES },
] as const;

/** One media type's rows for a service, in the order the channel shows them. */
function rowsFor(
  type: MediaType,
  service: Service,
  providers: number[],
  country: string,
  pages: Pages,
  minYear?: number,
): RowDef[] {
  return SORTS.map(({ id, title, sortBy, votes }) => {
    const query: DiscoverQuery = {
      mediaType: type,
      watchProviders: providers,
      watchRegion: country,
      monetization: FLATRATE,
      voteCountGte: votes,
      sortBy: sortBy || (type === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc'),
      releaseDateGte: minYear ? `${minYear}-01-01` : undefined,
      // A release-date sort with no upper bound leads with things that are not out yet.
      releaseDateLte: id === 'new' ? new Date().toISOString().slice(0, 10) : undefined,
    };
    return {
      // The source, the service and its country are all part of the id: a row is keyed by it, and two rows sharing
      // one would let a reused surface keep the other's posters.
      id: `service-tmdb-${service.id}-${country}-${id}-${type}`,
      title: `${title} ${NOUN[type]}`,
      load: (page: number) => pages(`/discover/${type}`, type, discoverParams(query), page),
    };
  });
}

/**
 * What a service's page shows: its popular, its recent and its acclaimed, for each media type it carries, films and
 * series alternating. Nothing is capped — each row pages on until TMDB runs out — and a row that comes back empty
 * hides itself, so the page ends up as deep as the service really is.
 */
export function serviceRows(
  service: Service,
  country: string,
  pages: Pages,
  { minYear, only }: { minYear?: number; only?: MediaType } = {},
): RowDef[] {
  // Every id the service folded in, so a title listed under "Netflix Standard with Ads" is still on Netflix.
  const providers = [service.id, ...service.variants];
  const wanted = (type: MediaType) => (only ? only === type : true);
  const movies =
    service.movies && wanted('movie')
      ? rowsFor('movie', service, providers, country, pages, minYear)
      : [];
  const series =
    service.series && wanted('tv')
      ? rowsFor('tv', service, providers, country, pages, minYear)
      : [];
  return movies
    .flatMap((row, i) => (series[i] ? [row, series[i]] : [row]))
    .concat(
      // Whichever list is longer keeps its tail.
      series.slice(movies.length),
    );
}
