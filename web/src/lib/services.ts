// The streaming-service screens, as the TV has them (ServiceRow on Home, ServiceChannelView behind a tile): which
// services a viewer is shown, and what one of them carries.
//
// A service is picked per country, because a catalogue is licensed per country — Netflix US and Netflix FI hold
// different films — so every query here names the country, and TMDB's availability is JustWatch's data, which is why
// both surfaces carry its credit.

import { discoverParams, type DiscoverQuery, type Pages, type RowDef } from './catalog';
import type { MediaType } from './library';
import type { ServicePick } from './prefs';
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

/** Subscription only. TMDB leaks rent and buy through this filter even so, which the vote floors below cover for. */
const FLATRATE = ['flatrate'];

/**
 * The floor under every row. A bare provider filter is most of a catalogue, and most of a catalogue is unrated
 * filler; `acclaimed` needs a harder one, since an average over a handful of votes says nothing.
 */
const VOTES = 50;
const ACCLAIMED_VOTES = 300;

const NOUN: Record<MediaType, string> = { movie: 'Movies', tv: 'Series' };

/** The sorts a service's own rows are, per media type it carries. */
const SORTS = [
  { id: 'popular', title: 'Popular', sortBy: 'popularity.desc', votes: VOTES },
  // TMDB has no "added to the service" date and no sort for one, so this is the release date and must never claim
  // otherwise: "Recently released", never "Recently added".
  { id: 'new', title: 'Recently released', sortBy: '', votes: VOTES },
  { id: 'acclaimed', title: 'Acclaimed', sortBy: 'vote_average.desc', votes: ACCLAIMED_VOTES },
] as const;

/** One media type's rows for a service, in the order the channel shows them. */
function rowsFor(
  type: MediaType,
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
      id: `service-${id}-${type}`,
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
  { minYear }: { minYear?: number } = {},
): RowDef[] {
  // Every id the service folded in, so a title listed under "Netflix Standard with Ads" is still on Netflix.
  const providers = [service.id, ...service.variants];
  const movies = service.movies ? rowsFor('movie', providers, country, pages, minYear) : [];
  const series = service.series ? rowsFor('tv', providers, country, pages, minYear) : [];
  return movies
    .flatMap((row, i) => (series[i] ? [row, series[i]] : [row]))
    .concat(
      // Whichever list is longer keeps its tail.
      series.slice(movies.length),
    );
}
