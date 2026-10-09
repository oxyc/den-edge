// The streaming-service screens, as the TV has them (ServiceRow on Home, ServiceChannelView behind a tile): which
// services a viewer is shown, and what one of them carries.
//
// A service is picked per country, because a catalogue is licensed per country — Netflix US and Netflix FI hold
// different films — so every query here names the country, and TMDB's availability is JustWatch's data, which is why
// both surfaces carry its credit.

import {
  catalogPage,
  categories,
  contentPages,
  discoverParams,
  interleave,
  matchesPrimaryGenre,
  type DiscoverQuery,
  type Pages,
  type RowDef,
} from './catalog';
import type { ContentServiceClientPort } from './libraryServiceFactory';
import type { ContentAtlasCatalog } from './contentServiceProtocol';
import type { MediaType, Title } from './library';
import type { ServicePick } from './prefs';
import { reuse } from './reuse';
import { contentServices, matches, type Service } from '../settings/services';

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
export type AtlasCatalog = ContentAtlasCatalog;

/** The stable whole-catalog slot a chart can improve without changing the row the page already published. */
export type ServiceRowSlot = 'new' | 'popular';

export type AtlasServiceRow = RowDef & {
  type: MediaType;
  /** Leaving/coming rows have no TMDB equivalent and therefore do not replace a stable service slot. */
  replaces?: ServiceRowSlot;
  /**
   * The chart's titles before the art atlas could not name is filled in (`fillPosters`): enough to decide whether the
   * row exists and what the hero shows, without waiting on a dozen TMDB lookups per chart. `load(1)` is these, filled.
   */
  listed?: () => Promise<Title[]>;
};

/**
 * atlas's own catalogs for services, read from its manifest rather than named here.
 *
 * The ids are atlas's (`jw-nfx`, `jw-nfx-new`), and which services it carries changes with its releases — so the
 * manifest is what says whether a service has rows at all, and what they are called.
 */
export function atlasCatalogs(content: ContentServiceClientPort): Promise<AtlasCatalog[]> {
  return content
    .query({ kind: 'atlas.service.catalogs' })
    .then(({ catalogs }) => (catalogs.state === 'ready' ? catalogs.value : []));
}

/**
 * How many of a chart's titles are worth naming art for when atlas could not.
 *
 * A chart is about a hundred titles and a row shows a handful; almost nobody scrolls one to its end. Filling the head
 * of it costs a dozen lookups instead of a hundred, and the rest keep their placeholder until someone scrolls — which
 * is the same bargain the rows themselves make.
 */
const FILL_HEAD = 12;
/**
 * The art atlas could not name, normalized by the content Worker from the TMDB id atlas gave — never by IMDb id,
 * which for a split anthology can name a different title.
 */
export async function fillPosters(
  titles: Title[],
  content: ContentServiceClientPort,
  { head = FILL_HEAD } = {},
): Promise<Title[]> {
  // Only TMDB's own path counts as art already named. A chart's `poster` is metahub's, and metahub answers
  // from images.metahub.space with a redirect to live.metahub.space — a host the page's own CSP does not
  // allow, so the browser blocks it and the card draws an empty frame. Counting that as art is what left
  // Libang Libu blank on Netflix's row while TMDB held a perfectly good poster for it.
  const wanted = titles.filter((title) => !title.posterPath).slice(0, head);
  if (!wanted.length) return titles;
  const key_ = (title: Pick<Title, 'type' | 'id'>) => `${title.type}:${title.id}`;
  const answer = await content.query({
    kind: 'titles',
    titles: wanted.map(({ type, id }) => ({ type, id })),
  });
  const found = new Map(answer.titles.map((title) => [key_(title), title]));
  const retryable = new Set(answer.retryable.map(key_));
  const asked = new Set(wanted.map(key_));
  return titles.flatMap((title) => {
    const id = key_(title);
    if (!asked.has(id) || retryable.has(id)) return [title];
    const normalized = found.get(id);
    return normalized ? [{ ...title, ...normalized }] : [];
  });
}

/**
 * A service's rows from atlas: what is popular on it, what is new, what is leaving and what is coming — the last three
 * being facts TMDB does not carry at all.
 *
 * One request each, and one page: these are charts, not a catalogue to page through, so a second page is empty.
 */
export function atlasServiceRows(
  catalogs: readonly AtlasCatalog[],
  service: Service,
  country: string,
  {
    only,
    content,
  }: {
    only?: MediaType;
    /** Worker-owned normalization for chart art atlas could not name. */
    content: ContentServiceClientPort;
  },
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
    .map((catalog) => {
      const listed = async () => {
        const answer = await content.query({
          kind: 'atlas.service.chart',
          catalog: { id: catalog.id, type: catalog.type },
          country,
        });
        return answer.titles.state === 'ready' ? answer.titles.value : [];
      };
      const filled = () => listed().then((titles) => fillPosters(titles, content));
      return {
        id: `service-atlas-${service.id}-${country}-${catalog.id}-${catalog.type}`,
        title: mixed ? `${catalog.name} · ${NOUN[catalog.type]}` : catalog.name,
        type: catalog.type,
        replaces: catalog.id.endsWith('-new')
          ? ('new' as const)
          : catalog.id.endsWith('-leaving') || catalog.id.endsWith('-coming')
            ? undefined
            : ('popular' as const),
        listed,
        load: async (page: number) => (page > 1 ? [] : filled()),
      };
    });
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
  catalogs: readonly AtlasCatalog[],
  picks: readonly ServicePick[],
  {
    only,
    names = {},
    content,
  }: {
    only?: MediaType;
    /** Provider id → the service's name, for the card's caption. A visitor has no directory, and so no names. */
    names?: Record<number, string>;
    content: ContentServiceClientPort;
  },
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
            const answer = await content.query({
              kind: 'atlas.service.chart',
              catalog: { id: catalog.id, type: catalog.type },
              country,
            });
            if (answer.titles.state !== 'ready') return [];
            const named = catalog.providerIds.flatMap((id) => names[id] ?? []).slice(0, 1);
            return answer.titles.value.map((title) => ({ ...title, services: named }));
          });
          const merged = mergePool(charts, pool.soonest);
          return fillPosters(merged, content);
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
  // Which rows exist is decided by the charts' titles alone. Their art is filled when a row asks for its first page,
  // so the page is not held for the slowest of every chart's poster lookups before it can publish a single row.
  const answered = (
    await Promise.all(
      atlas.map(async (row) => {
        try {
          const titles = distinct(await (row.listed ? row.listed() : row.load(1)));
          return titles.length ? { row, titles } : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((answer): answer is { row: AtlasServiceRow; titles: Title[] } => answer !== null);
  /** A row's first page with its art, once; the listed titles stand if the art cannot be had. */
  const firstPage = ({ row, titles }: { row: AtlasServiceRow; titles: Title[] }) => {
    let head: Promise<Title[]> | undefined;
    return () =>
      (head ??= row.listed ? row.load(1).then(distinct, () => titles) : Promise.resolve(titles));
  };

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
    const head = firstPage(answer);
    const pages = new Map<number, Title[]>();
    let serial = Promise.resolve<Title[]>([]);
    const load = (page: number) => {
      if (page === 1) return head();
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
    .map((answer) => {
      const head = firstPage(answer);
      return { ...answer.row, load: (page: number) => (page === 1 ? head() : Promise.resolve([])) };
    });
  const afterHead = stable.findIndex((row) => !row.id.startsWith('service-tmdb-'));
  const split = afterHead < 0 ? stable.length : afterHead;
  return [...stable.slice(0, split), ...extras, ...stable.slice(split)];
}

/** Each title once, in the order first seen: a chart can name one twice. */
function distinct(titles: Title[]): Title[] {
  const seen = new Set<string>();
  return titles.filter((title) => {
    const key = `${title.type}:${title.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** As many as are worth cycling; the TV's hero carries forty, and a service's lead row is shorter than that. */
const HERO_SLIDES = 12;

/**
 * The titles the hero leads with: the head of the page's leading row, as the TV's channel page opens with one
 * (`ServiceChannelView`) — what has just arrived on the service where atlas says so, and what was most recently
 * released where it doesn't.
 *
 * Asked of that one chart directly rather than of the settled rows, so the hero is not held until every other chart,
 * and every chart's art, has answered.
 */
export async function serviceHero(
  atlas: readonly AtlasServiceRow[],
  tmdb: readonly RowDef[],
): Promise<Title[]> {
  const lead = tmdb[0];
  if (!lead) return [];
  // The chart that takes the lead row's place when it answers (`settleServiceRows`).
  const chart = atlas.find((row) => row.replaces === 'new' && lead.id.endsWith(`-new-${row.type}`));
  if (chart) {
    const titles = await (chart.listed ? chart.listed() : chart.load(1)).catch(() => []);
    if (titles.length) return distinct(titles);
  }
  return distinct(await lead.load(1));
}

/**
 * The hero's titles with a picture to show.
 *
 * A chart names no backdrop, so each slide used to look one up only once it was on screen — and a title TMDB has no
 * backdrop for left the hero black until the carousel moved on fifteen seconds later. Asked here, all at once and by
 * the same question `fillPosters` asks, so a chart's poster lookup and the hero's are one request. A title TMDB
 * answers without a backdrop is left out; one it could not be asked about stays, and draws its own when it can.
 */
export async function withBackdrops(
  titles: Title[],
  content: ContentServiceClientPort,
  { head = HERO_SLIDES }: { head?: number } = {},
): Promise<Title[]> {
  const candidates = titles.slice(0, head);
  const looked: (Title | null)[] = [...candidates];
  const missing = candidates.flatMap((title, at) => (title.backdropPath ? [] : [{ title, at }]));
  const absent = new Set<number>();
  if (missing.length) {
    const answer = await content.query({
      kind: 'titles',
      titles: missing.map(({ title: { type, id } }) => ({ type, id })),
    });
    const key = (title: Pick<Title, 'type' | 'id'>) => `${title.type}:${title.id}`;
    const found = new Map(answer.titles.map((title) => [key(title), title]));
    const retryable = new Set(answer.retryable.map(key));
    for (const { title, at } of missing) {
      const id = key(title);
      if (retryable.has(id)) continue;
      const normalized = found.get(id);
      if (!normalized) {
        absent.add(at);
        looked[at] = null;
      } else {
        looked[at] = normalized.backdropPath ? { ...title, ...normalized } : null;
      }
    }
  }
  const pictured = looked.filter((title): title is Title => title !== null);
  // Nothing with a picture at all: the words are still a better hero than an empty one.
  return pictured.length ? pictured : candidates.filter((_, at) => !absent.has(at));
}

export interface ServicePageOptions {
  minYear?: number;
  only?: MediaType;
  excludedLanguages?: Set<string>;
  /** What the viewer has hidden; the hero leaves it out before looking anything up for it. */
  shown?: (title: Title) => boolean;
}

/**
 * A service page's two answers, asked side by side: its rows, settled once (`settleServiceRows`), and its hero, which
 * waits only on its own chart. Everything behind them is shared (`reuse`, `sharingFlights`), so asking again — the
 * page mounting after a hover primed it — joins what is already on its way.
 */
export function servicePage(
  content: ContentServiceClientPort,
  service: Service,
  country: string,
  atlas: string | null,
  { minYear, only, excludedLanguages, shown = () => true }: ServicePageOptions = {},
): { rows: Promise<RowDef[]>; hero: Promise<Title[]> } {
  const tmdb = serviceRows(service, country, contentPages(content), {
    minYear,
    only,
    excludedLanguages,
  });
  const own = atlas
    ? atlasCatalogs(content).then((catalogs) =>
        atlasServiceRows(catalogs, service, country, { only, content }),
      )
    : Promise.resolve([]);
  return {
    // Manifest failure is a settled answer too: the complete TMDB page, once, with stable row keys.
    rows: atlas
      ? own.then(
          (rows) => settleServiceRows(rows, tmdb),
          () => tmdb,
        )
      : Promise.resolve(tmdb),
    hero: own
      .catch((): AtlasServiceRow[] => [])
      .then((rows) => serviceHero(rows, tmdb))
      .then((titles) => withBackdrops(titles.filter(shown), content)),
  };
}

/** The rows a page opens on, whose first page it asks for the moment it mounts. */
const PRIMED_ROWS = 3;

/**
 * Start a service page's requests before it is opened: a pointer resting on its tile, a focus, a touch. The page asks
 * the same questions when it mounts and joins these rather than starting again. Nothing runs unasked — this is one
 * page's first screen, on a gesture towards it, and a second gesture within a few minutes asks nothing more.
 */
export function primeServicePage(
  content: ContentServiceClientPort,
  service: Service,
  country: string,
  atlas: string | null,
  options: ServicePageOptions = {},
): void {
  const key = `prime:${service.id}:${country}:${atlas ?? ''}:${options.minYear ?? ''}`;
  void reuse(key, async () => {
    void contentServices(content, country).catch(() => undefined);
    const page = servicePage(content, service, country, atlas, options);
    await Promise.all([
      page.hero,
      page.rows.then((rows) => Promise.all(rows.slice(0, PRIMED_ROWS).map((row) => row.load(1)))),
    ]);
  }).catch(() => undefined);
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
      load: (page: number) =>
        catalogPage(
          pages,
          { kind: 'discover', query },
          [`/discover/${type}`, type, discoverParams(query)],
          page,
        ),
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
    filter:
      c.query.primaryGenre === undefined
        ? undefined
        : (title: Title) => matchesPrimaryGenre(title, c.query.primaryGenre!),
    load: (page: number) => {
      const query = scoped(c.query);
      const { primaryGenre: _primaryGenre, ...contentQuery } = query;
      return catalogPage(
        pages,
        { kind: 'discover', query: contentQuery },
        [`/discover/${c.query.mediaType}`, c.query.mediaType, discoverParams(query)],
        page,
      );
    },
  }));
  return [...lead, ...feed];
}
