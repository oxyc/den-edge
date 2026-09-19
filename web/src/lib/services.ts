// The streaming-service screens, as the TV has them (ServiceRow on Home, ServiceChannelView behind a tile): which
// services a viewer is shown, and what one of them carries.
//
// A service is picked per country, because a catalogue is licensed per country — Netflix US and Netflix FI hold
// different films — so every query here names the country, and TMDB's availability is JustWatch's data, which is why
// both surfaces carry its credit.

import {
  categories,
  discoverParams,
  interleave,
  type DiscoverQuery,
  type Pages,
  type RowDef,
} from './catalog';
import type { MediaType, Title } from './library';
import type { ServicePick } from './prefs';
import { relayFetch } from './relayFetch';
import { tmdbFetch } from './tmdbCache';
import { rememberAtlasMetadata, withSharedTitleMetadata } from './titleMetadata';
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

/** The stable whole-catalog slot a chart can improve without changing the row the page already published. */
export type ServiceRowSlot = 'new' | 'popular';

export type AtlasServiceRow = RowDef & {
  type: MediaType;
  /** Leaving/coming rows have no TMDB equivalent and therefore do not replace a stable service slot. */
  replaces?: ServiceRowSlot;
};

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
    const rating = Number(meta.imdbRating);
    return [
      {
        type,
        id,
        title: meta.name,
        posterPath: typeof meta.posterPath === 'string' ? meta.posterPath : undefined,
        // The chart's own art is keyed by IMDb id, and for a series that id is often the whole anthology's: TMDB
        // splits "Monster" into one show per story, IMDb keeps one, so the Lizzie Borden story was drawn with
        // Dahmer's poster. Wrong art is worse than none, and a film's two ids agree, so the fallback is films only.
        posterUrl: type === 'movie' && typeof meta.poster === 'string' ? meta.poster : undefined,
        year: Number.isInteger(year) && year > 1800 ? year : undefined,
        rating: Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating : undefined,
        imdbId: typeof meta.imdb_id === 'string' ? meta.imdb_id : undefined,
        // When it lands on the service, or leaves it (atlas's `denAt`, in seconds). Only its leaving and coming
        // charts carry one, and a chart older than atlas 0.41.0 carries none at all, so a row must still work
        // without it.
        arrivesAt: typeof meta.denAt === 'number' ? meta.denAt * 1000 : undefined,
      },
    ];
  });
}

/**
 * How many of a chart's titles are worth naming art for when atlas could not.
 *
 * A chart is about a hundred titles and a row shows a handful; almost nobody scrolls one to its end. Filling the head
 * of it costs a dozen lookups instead of a hundred, and the rest keep their placeholder until someone scrolls — which
 * is the same bargain the rows themselves make.
 */
const FILL_HEAD = 12;
/** At once. den-edge answers /tmdb at 120 a minute per address, and a page has its own asking to do. */
const FILL_AT_ONCE = 4;

/**
 * The art atlas could not name, asked of TMDB by the id atlas gave — never by the IMDb id, which for a split anthology
 * names something else.
 *
 * Every browser asks through den-edge (`tmdbCache`), so a title is fetched from TMDB once and answered from its cache
 * for every device and visitor after that.
 */
export async function fillPosters(
  titles: Title[],
  key: string,
  { head = FILL_HEAD, atOnce = FILL_AT_ONCE, fetchImpl = tmdbFetch } = {},
): Promise<Title[]> {
  // Only TMDB's own path counts as art already named. A chart's `poster` is metahub's, and metahub answers
  // from images.metahub.space with a redirect to live.metahub.space — a host the page's own CSP does not
  // allow, so the browser blocks it and the card draws an empty frame. Counting that as art is what left
  // Libang Libu blank on Netflix's row while TMDB held a perfectly good poster for it.
  const wanted = titles.filter((title) => !title.posterPath).slice(0, head);
  if (!wanted.length) return titles;
  const found = new Map<string, string>();
  const key_ = (title: Title) => `${title.type}:${title.id}`;
  for (let at = 0; at < wanted.length; at += atOnce) {
    await Promise.all(
      wanted.slice(at, at + atOnce).map(async (title) => {
        try {
          const url = `https://api.themoviedb.org/3/${title.type}/${title.id}?api_key=${encodeURIComponent(key)}`;
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return;
          const body = (await res.json()) as { poster_path?: unknown };
          if (typeof body.poster_path === 'string') found.set(key_(title), body.poster_path);
        } catch {
          // No art for this one: it keeps its placeholder, and the row is not held up for it.
        }
      }),
    );
  }
  return titles.map((title) =>
    found.has(key_(title)) ? { ...title, posterPath: found.get(key_(title)) } : title,
  );
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
  {
    only,
    tmdbKey,
    fetchImpl = relayFetch,
  }: {
    only?: MediaType;
    /** With one, the head of a chart gets the art atlas could not name (`fillPosters`). */
    tmdbKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): AtlasServiceRow[] {
  const ids = new Set([service.id, ...service.variants]);
  // What has just arrived leads, as it does in the TMDB rows: then what is popular, then what is about to go or
  // about to land. atlas's manifest lists them popular-first, which is its own order and not this page's.
  const rank = (id: string) =>
    id.endsWith('-new') ? 0 : id.endsWith('-leaving') ? 2 : id.endsWith('-coming') ? 3 : 1;
  const wanted = catalogs.filter(
    (c) => (only ? c.type === only : true) && c.providerIds.some((id) => ids.has(id)),
  );
  // atlas names a chart after the service alone ("New on Netflix"), and names the film and series ones identically. On
  // a page showing both, the media type has to be said or the page reads as every row twice.
  const mixed = wanted.some((c) => c.type === 'movie') && wanted.some((c) => c.type === 'tv');
  return wanted
    .slice()
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((catalog) => ({
      id: `service-atlas-${service.id}-${country}-${catalog.id}-${catalog.type}`,
      title: mixed ? `${catalog.name} · ${NOUN[catalog.type]}` : catalog.name,
      type: catalog.type,
      replaces: catalog.id.endsWith('-new')
        ? ('new' as const)
        : catalog.id.endsWith('-leaving') || catalog.id.endsWith('-coming')
          ? undefined
          : ('popular' as const),
      load: async (page: number) => {
        if (page > 1) return [];
        const path = catalog.type === 'tv' ? 'series' : 'movie';
        const res = await fetchImpl(
          `${base}/catalog/${path}/${catalog.id}/country=${encodeURIComponent(country)}.json`,
        );
        if (!res.ok) throw new Error(`atlas answered ${res.status}`);
        const received = titlesOfMetas(await res.json());
        rememberAtlasMetadata(received, fetchImpl);
        const titles = await withSharedTitleMetadata(received, fetchImpl);
        return tmdbKey ? fillPosters(titles, tmdbKey) : titles;
      },
    }));
}

/**
 * The two pooled rows: what has just landed anywhere the viewer looks, and what is about to.
 *
 * A service page answers "what is on Netflix"; this answers "what is new", which is the question someone browsing
 * actually has. Only atlas can: TMDB has no arrival date and no notion of a catalogue changing, so its nearest
 * equivalent is a release-date sort, which says when a film came out and not when it turned up here.
 */
const POOLS = [
  { id: 'new', suffix: '-new', title: 'New Releases', soonest: false },
  { id: 'coming', suffix: '-coming', title: 'Coming Soon', soonest: true },
] as const;

/** Charts at once. Twelve services' charts in one go is a burst den-edge's relay would rather not take at once. */
const POOL_AT_ONCE = 6;

/**
 * One row per pool, over every service the viewer has, in the country each was picked for.
 *
 * Coverage is atlas's to decide: a pool only lists the services whose chart of that kind exists, so a row can be
 * about four services where the page shows six, and says so by simply being the titles it found.
 */
export function radarRows(
  base: string,
  catalogs: readonly AtlasCatalog[],
  picks: readonly ServicePick[],
  {
    only,
    names = {},
    tmdbKey,
    fetchImpl = relayFetch,
  }: {
    only?: MediaType;
    /** Provider id → the service's name, for the card's caption. A visitor has no directory, and so no names. */
    names?: Record<number, string>;
    tmdbKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): RowDef[] {
  return POOLS.flatMap((pool) => {
    const asked = new Map<string, { catalog: AtlasCatalog; country: string }>();
    for (const catalog of catalogs) {
      if (!catalog.id.endsWith(pool.suffix) || (only && catalog.type !== only)) continue;
      for (const pick of picks) {
        // One request per chart per country, however many of a service's ids the viewer's pick names.
        if (catalog.providerIds.includes(pick.id))
          asked.set(`${catalog.id}:${pick.country}`, { catalog, country: pick.country });
      }
    }
    const wanted = [...asked.values()];
    if (!wanted.length) return [];
    return [
      {
        id: `radar-${pool.id}-${only ?? 'all'}`,
        title: pool.title,
        caption: (title: Title) => captionOf(title, pool.soonest),
        load: async (page: number) => {
          if (page > 1) return [];
          const charts = await inBatches(wanted, POOL_AT_ONCE, async ({ catalog, country }) => {
            const path = catalog.type === 'tv' ? 'series' : 'movie';
            const res = await fetchImpl(
              `${base}/catalog/${path}/${catalog.id}/country=${encodeURIComponent(country)}.json`,
            );
            if (!res.ok) return [];
            const named = catalog.providerIds.flatMap((id) => names[id] ?? []).slice(0, 1);
            return titlesOfMetas(await res.json()).map((title) => ({ ...title, services: named }));
          });
          const merged = mergePool(charts, pool.soonest);
          rememberAtlasMetadata(merged, fetchImpl);
          const titles = await withSharedTitleMetadata(merged, fetchImpl);
          return tmdbKey ? fillPosters(titles, tmdbKey) : titles;
        },
      },
    ];
  });
}

/**
 * Home's one "what's new" shelf: what has just landed on the viewer's services, then what has just come out.
 *
 * Two rows were asking nearly the same question side by side, and meaning different things by it — TMDB's by
 * release date, atlas's by the day a title turned up on a service — so a recent film that had just landed
 * appeared in both, and neither title said which sense of "new" it meant. Merged, the arrivals lead (a 1997 film
 * added to a service last week is news here in a way its release date can never say), and TMDB's recent releases
 * follow and page on exactly as they did, less anything the arrivals already named.
 *
 * A film that is out but on no service is still worth showing — this household watches through its own sources —
 * so the release half is not a fallback for the arrivals half. Both are real answers.
 */
export function mergeNewRow(arrivals: RowDef, releases: RowDef, title = 'New Releases'): RowDef {
  const key = (t: Title) => `${t.type}:${t.id}`;
  return {
    id: `new-merged-${arrivals.id}`,
    title,
    // A chart title says which service it landed on; a TMDB one has no service and keeps the year.
    caption: (t: Title) => arrivals.caption?.(t) ?? (t.year ? String(t.year) : undefined),
    load: async (page: number) => {
      // The charts are one page; past the first, the row is TMDB's alone, which is what pages on.
      if (page > 1) return releases.load(page);
      const [landed, out] = await Promise.all([
        // atlas failing must not take the row with it: TMDB's half stands on its own, as it did before.
        arrivals.load(1).catch((): Title[] => []),
        releases.load(1),
      ]);
      const seen = new Set(landed.map(key));
      return [...landed, ...out.filter((title) => !seen.has(key(title)))];
    },
  };
}

/** `work` over `items`, `atOnce` at a time; one that fails contributes nothing rather than failing the row. */
async function inBatches<T, R>(
  items: readonly T[],
  atOnce: number,
  work: (item: T) => Promise<R[]>,
): Promise<R[][]> {
  const out: R[][] = [];
  for (let at = 0; at < items.length; at += atOnce) {
    out.push(
      ...(await Promise.all(
        items.slice(at, at + atOnce).map((item) => work(item).catch(() => [])),
      )),
    );
  }
  return out;
}

/**
 * Several services' charts as one row: each service takes a turn, a title on two of them is named once, and a date
 * decides the order wherever the charts carry one.
 */
function mergePool(charts: Title[][], soonest: boolean): Title[] {
  const order: Title[] = [];
  const byKey = new Map<string, Title>();
  // Round-robin rather than one chart after another, so no single service owns the head of the row.
  for (let i = 0; charts.some((chart) => i < chart.length); i++) {
    for (const chart of charts) {
      const title = chart[i];
      if (!title) continue;
      const key = `${title.type}:${title.id}`;
      const already = byKey.get(key);
      if (already) {
        // On two services: the card names both instead of the row showing it twice. The kept title is the same
        // object the row holds, so this reaches the card.
        already.services = [...new Set([...(already.services ?? []), ...(title.services ?? [])])];
        continue;
      }
      byKey.set(key, title);
      order.push(title);
    }
  }
  // A date beats the charts' own order — but only for the titles that have one. atlas carried none before 0.41.0,
  // and a popularity-shaped chart never will, so the undated keep the round-robin exactly as it was above.
  return order.slice().sort((a, b) => {
    if (a.arrivesAt === b.arrivesAt) return 0;
    if (a.arrivesAt === undefined) return 1;
    if (b.arrivesAt === undefined) return -1;
    return soonest ? a.arrivesAt - b.arrivesAt : b.arrivesAt - a.arrivesAt;
  });
}

const DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const SERVICE_NAME_MAX = 15;
const SERVICE_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MARKETPLACE_CHANNEL = /\s+(?:amazon|apple tv\+?|roku premium) channel$/iu;

/** Keep a poster caption's provider beside its date instead of letting a marketplace variant consume the row. */
export function compactServiceName(name: string): string {
  const trimmed = name.trim();
  // These are the channel variants the service picker already folds into their parent service.
  // Keep a provider whose entire name happens to be the suffix rather than returning an empty caption.
  const withoutChannel = trimmed.replace(MARKETPLACE_CHANNEL, '').trimEnd();
  const channel = withoutChannel || trimmed;
  const graphemes = [...SERVICE_GRAPHEMES.segment(channel)].map(({ segment }) => segment);
  return graphemes.length <= SERVICE_NAME_MAX
    ? channel
    : `${graphemes
        .slice(0, SERVICE_NAME_MAX - 1)
        .join('')
        .trimEnd()}…`;
}

/** Which service a pooled card is on, and — for a row about what is still to come — the day it lands. */
function captionOf(title: Title, dated: boolean): string | undefined {
  const services = title.services?.map(compactServiceName).filter(Boolean) ?? [];
  const where = services.length ? compactServiceName(services.join(' · ')) : undefined;
  const when =
    dated && title.arrivesAt !== undefined ? DATE.format(new Date(title.arrivesAt)) : undefined;
  return [where, when].filter(Boolean).join(' · ') || undefined;
}

/**
 * A service's page: atlas's rows where it has them, and TMDB's for what atlas does not do.
 *
 * Where atlas covers a service, its charts replace TMDB's popular and recently-released rows for that media type —
 * two rows about the same thing from two sources, with different titles in them, is worse than either alone, and
 * atlas's "New on …" is a real arrivals list where TMDB's is a release date standing in for one. Acclaimed has no
 * atlas equivalent and always comes from TMDB.
 */
export async function settleServiceRows(
  atlas: readonly AtlasServiceRow[],
  tmdb: readonly RowDef[],
): Promise<RowDef[]> {
  const answered = (
    await Promise.all(
      atlas.map(async (row) => {
        try {
          const seen = new Set<string>();
          const titles = (await row.load(1)).filter((title) => {
            const key = `${title.type}:${title.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return titles.length ? { row, titles } : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((answer): answer is { row: AtlasServiceRow; titles: Title[] } => answer !== null);

  const used = new Set<string>();
  const stable = tmdb.map((fallback) => {
    const answer = answered.find(
      ({ row }) =>
        row.replaces &&
        fallback.id.endsWith(`-${row.replaces}-${row.type}`) &&
        !used.has(`${row.replaces}:${row.type}`),
    );
    if (!answer || !answer.row.replaces) return fallback;
    used.add(`${answer.row.replaces}:${answer.row.type}`);

    // Keep the published row's identity and heading. The chart supplies its first page; TMDB supplies the
    // endless catalog behind it. Skip duplicate-only fallback pages so Browse does not mistake one for EOF.
    const seen = new Set(answer.titles.map((title) => `${title.type}:${title.id}`));
    let fallbackPage = 1;
    const pages = new Map<number, Title[]>([[1, answer.titles]]);
    let serial = Promise.resolve<Title[]>([]);
    const load = (page: number) => {
      const cached = pages.get(page);
      if (cached) return Promise.resolve(cached);
      serial = serial.then(async () => {
        const already = pages.get(page);
        if (already) return already;
        for (;;) {
          const titles = await fallback.load(fallbackPage++);
          if (!titles.length) {
            pages.set(page, []);
            return [];
          }
          const unique = titles.filter((title) => {
            const key = `${title.type}:${title.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (unique.length) {
            pages.set(page, unique);
            return unique;
          }
        }
      });
      return serial;
    };
    return { ...fallback, load };
  });

  const extras = answered
    .filter(({ row }) => !row.replaces)
    .map(({ row, titles }) => ({
      ...row,
      load: (page: number) => Promise.resolve(page === 1 ? titles : []),
    }));
  const afterHead = stable.findIndex((row) => !row.id.startsWith('service-tmdb-'));
  const split = afterHead < 0 ? stable.length : afterHead;
  return [...stable.slice(0, split), ...extras, ...stable.slice(split)];
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
  {
    minYear,
    only,
    excludedLanguages = new Set<string>(),
    now = new Date(),
  }: {
    minYear?: number;
    only?: MediaType;
    excludedLanguages?: Set<string>;
    now?: Date;
  } = {},
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
  const lead = movies
    .flatMap((row, i) => (series[i] ? [row, series[i]] : [row]))
    .concat(
      // Whichever list is longer keeps its tail.
      series.slice(movies.length),
    );

  /**
   * Then the whole catalogue, re-pointed at this service — the TV's own trick (`DiscoveryCatalog`): every
   * genre, recipe, decade back to the 1950s and country row, each asking only for what this service carries.
   *
   * Three sorts is a fixed page whatever the service is. This is not: a row that comes back empty hides
   * itself, so the page ends up exactly as deep as the service actually is, and a thin one stays short
   * without anybody choosing a number.
   */
  const scoped = (query: DiscoverQuery): DiscoverQuery => ({
    ...query,
    watchProviders: providers,
    watchRegion: country,
    monetization: FLATRATE,
  });
  const carries = (type: MediaType) => (type === 'movie' ? service.movies : service.series);
  const feedFor = (type: MediaType) =>
    wanted(type) && carries(type)
      ? // Acclaimed is already the third row above; the feed would say it twice.
        categories(type, now.getFullYear(), { minYear, excludedLanguages }).filter(
          (c) => c.id !== `acclaimed-${type}`,
        )
      : [];
  const feed = interleave([feedFor('movie'), feedFor('tv')]).map((c) => ({
    id: `service-feed-${service.id}-${country}-${c.id}`,
    title: c.title,
    load: (page: number) =>
      pages(
        `/discover/${c.query.mediaType}`,
        c.query.mediaType,
        discoverParams(scoped(c.query)),
        page,
      ),
  }));
  return [...lead, ...feed];
}
