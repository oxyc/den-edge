// What the browse screens show, ported from the TV: Home's spine (TMDBDiscovery.homeRows and its recipe rows), the
// Movies and Series tabs (BrowseModel), and the endless tail under both (DiscoveryCatalog.categories, RecipeCatalog,
// GenreCatalog). Pure definitions: each row fetches its own pages, once it scrolls into view.

import type { MediaType, Title } from './library';
import { titleHref } from './route';
import { toTitle } from './tmdb';

import { tmdbFetch } from './tmdbCache';

const TMDB = 'https://api.themoviedb.org/3';

/** A TMDB `/discover` query (DenKit DiscoverQuery). Within one parameter a comma is AND and a pipe OR. */
export interface DiscoverQuery {
  mediaType: MediaType;
  genres?: number[];
  genreJoin?: 'and' | 'or';
  /** Client-side shelf membership. TMDB's genre filter includes titles carrying this only secondarily. */
  primaryGenre?: number;
  /** Always OR-joined, as every recipe uses them. */
  keywords?: number[];
  withoutGenres?: number[];
  originalLanguage?: string;
  /** OR-joined. */
  originCountry?: string[];
  voteCountGte?: number;
  releaseDateGte?: string;
  releaseDateLte?: string;
  sortBy?: string;
  /** JustWatch provider ids, OR-joined: what a service's own rows are. */
  watchProviders?: number[];
  /** The country the availability is for (ISO-3166 alpha-2). A catalogue is licensed per country. */
  watchRegion?: string;
  /** `flatrate` for what a subscription carries, against `rent`/`buy`. */
  monetization?: string[];
}

export function discoverParams(q: DiscoverQuery): Record<string, string> {
  const params: Record<string, string> = {
    sort_by: q.sortBy ?? 'popularity.desc',
    include_adult: 'false',
  };
  if (q.genres?.length) params.with_genres = q.genres.join(q.genreJoin === 'or' ? '|' : ',');
  if (q.keywords?.length) params.with_keywords = q.keywords.join('|');
  if (q.withoutGenres?.length) params.without_genres = q.withoutGenres.join(',');
  if (q.originalLanguage) params.with_original_language = q.originalLanguage;
  if (q.originCountry?.length) params.with_origin_country = q.originCountry.join('|');
  if (q.voteCountGte !== undefined) params['vote_count.gte'] = String(q.voteCountGte);
  const date = q.mediaType === 'tv' ? 'first_air_date' : 'primary_release_date';
  if (q.releaseDateGte) params[`${date}.gte`] = q.releaseDateGte;
  if (q.releaseDateLte) params[`${date}.lte`] = q.releaseDateLte;
  // TMDB ignores `with_watch_providers` when nothing says which country the availability is in — and answers the
  // whole catalogue as though the filter had been asked for. The pair travels together or not at all.
  if (q.watchProviders?.length && q.watchRegion) {
    params.with_watch_providers = q.watchProviders.join('|');
    params.watch_region = q.watchRegion;
    if (q.monetization?.length) params.with_watch_monetization_types = q.monetization.join('|');
  }
  return params;
}

export const GENRES: Record<MediaType, Record<number, string>> = {
  movie: {
    28: 'Action',
    12: 'Adventure',
    16: 'Animation',
    35: 'Comedy',
    80: 'Crime',
    99: 'Documentary',
    18: 'Drama',
    10751: 'Family',
    14: 'Fantasy',
    36: 'History',
    27: 'Horror',
    10402: 'Music',
    9648: 'Mystery',
    10749: 'Romance',
    878: 'Science Fiction',
    10770: 'TV Movie',
    53: 'Thriller',
    10752: 'War',
    37: 'Western',
  },
  tv: {
    10759: 'Action & Adventure',
    16: 'Animation',
    35: 'Comedy',
    80: 'Crime',
    99: 'Documentary',
    18: 'Drama',
    10751: 'Family',
    10762: 'Kids',
    9648: 'Mystery',
    10763: 'News',
    10764: 'Reality',
    10765: 'Sci-Fi & Fantasy',
    10766: 'Soap',
    10767: 'Talk',
    10768: 'War & Politics',
    37: 'Western',
  },
};

/**
 * TMDB genre lists are inclusive rather than statements of primacy. Prefer the most specific genre so broad
 * secondary labels such as Comedy and Drama do not pull an Adventure/Animation title into their shelves.
 * These prevalence priors mirror DenKit's `GenreRarity`; the dataset's classified primary genre can supersede
 * them in the native client, while the web always has this metadata-only fallback.
 */
const GENRE_RARITY: Record<number, number> = {
  18: 0.5,
  35: 0.65,
  28: 0.85,
  53: 0.9,
  12: 1,
  10749: 1,
  878: 1.1,
  14: 1.15,
  10751: 1.15,
  27: 1.2,
  16: 1.2,
  9648: 1.25,
  80: 1.35,
  99: 1.45,
  36: 1.45,
  10402: 1.55,
  10752: 1.55,
  37: 1.85,
};

export function primaryGenre(genreIds: readonly number[]): number | undefined {
  let best: number | undefined;
  let weight = -Infinity;
  for (const id of genreIds) {
    const candidate = GENRE_RARITY[id] ?? 1;
    if (candidate > weight) {
      best = id;
      weight = candidate;
    }
  }
  return best;
}

/**
 * The TMDB genre id a title actually IS, for shelf membership.
 *
 * The corpus's own label first, where the card carries one — an atlas row and `/index/query` both do. It is
 * a NAME, so it is matched back through this type's `GENRES` table; a label that names no TMDB genre for
 * this type (the taxonomy has "Coming-of-Age", TMDB does not) falls through rather than excluding the
 * title on a technicality.
 *
 * Then the rarity heuristic over TMDB's ids, which is all there is for the millions of titles atlas has
 * never seen. Keeping that fallback explicit is the point: without it every row outside the 47,618-title
 * corpus would read as empty.
 *
 * This mirrors the TV's `IndexPrimaryGenre` so both clients answer the same genre for the same card.
 */
export function shelfGenre(title: Title): number | undefined {
  const named = title.primaryGenreName;
  if (named) {
    for (const [id, name] of Object.entries(GENRES[title.type] ?? {})) {
      if (name === named) return Number(id);
    }
  }
  return primaryGenre(title.genreIds ?? []);
}

export function matchesPrimaryGenre(title: Title, genre: number): boolean {
  return shelfGenre(title) === genre;
}

/** Append a fetched page once per typed title identity; movie and TV ids occupy separate namespaces. */
export function appendUniqueTitles(existing: readonly Title[], next: readonly Title[]): Title[] {
  const key = (title: Title) => `${title.type}:${title.id}`;
  const seen = new Set(existing.map(key));
  return [
    ...existing,
    ...next.filter((title) => {
      const id = key(title);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  ];
}

/** The TV's Explore order per type (GenreCatalog.exploreChips). */
export const EXPLORE: Record<MediaType, number[]> = {
  movie: [28, 35, 18, 27, 878, 10749, 53, 12, 16, 80, 14, 9648, 99],
  tv: [10759, 35, 18, 80, 10765, 16, 9648, 99, 10764, 10751],
};

/**
 * The closest genre across types for the genres TMDB splits differently (GenreCatalog.movieToTV / tvToMovie).
 * Ids both types share — Comedy, Drama, Crime, Animation, Family, Mystery, Documentary, Western — pass through.
 */
const GENRE_MOVIE_TO_TV: Record<number, number> = {
  28: 10759, // Action → Action & Adventure
  12: 10759, // Adventure → Action & Adventure
  14: 10765, // Fantasy → Sci-Fi & Fantasy
  878: 10765, // Science Fiction → Sci-Fi & Fantasy
  27: 10765, // Horror → Sci-Fi & Fantasy: there is no TV horror genre, and the supernatural lives here
  53: 9648, // Thriller → Mystery
  36: 99, // History → Documentary
  10749: 18, // Romance → Drama
  10402: 10764, // Music → Reality
  10752: 10768, // War → War & Politics
  10770: 18, // TV Movie → Drama
};
const GENRE_TV_TO_MOVIE: Record<number, number> = {
  10759: 28, // Action & Adventure → Action
  10762: 10751, // Kids → Family
  10763: 99, // News → Documentary
  10764: 99, // Reality → Documentary
  10765: 878, // Sci-Fi & Fantasy → Science Fiction
  10766: 10749, // Soap → Romance
  10767: 99, // Talk → Documentary
  10768: 10752, // War & Politics → War
};

/**
 * The genre in `to` closest to genre `id` of `from` (GenreCatalog.equivalent), so switching Movies and Series keeps
 * a related category open instead of one that type has no titles for. Undefined when nothing sensible matches.
 */
export function equivalentGenre(id: number, from: MediaType, to: MediaType): number | undefined {
  if (from === to || GENRES[to][id] !== undefined) return id;
  return (from === 'movie' ? GENRE_MOVIE_TO_TV : GENRE_TV_TO_MOVIE)[id];
}

/** Genre ids that are the same genre on `/discover/movie` and `/discover/tv` (DiscoverQuery.sharedGenres). */
const SHARED_GENRES = new Set([16, 18, 35, 37, 80, 99, 9648, 10751]);
/** The movie genres a TV discover query can fold into (DiscoverQuery.movieToTV); the rest have no TV form. */
const DISCOVER_MOVIE_TO_TV: Record<number, number> = {
  28: 10759,
  12: 10759,
  878: 10765,
  14: 10765,
  10752: 10768,
};

/**
 * This query for another type (DiscoverQuery.retargeted), so a movie recipe such as Heist browses as series, or
 * undefined where it can't be said faithfully — Sci-Fi Horror has no series form, since TV has no Horror genre.
 * AND-joined genres are strict: one with no counterpart changes the meaning, so the whole query is refused.
 * OR-joined genres drop only the branches that have none. Series to movies maps only the shared ids.
 */
export function retargeted(query: DiscoverQuery, to: MediaType): DiscoverQuery | undefined {
  if (query.mediaType === to) return query;
  const map = (genre: number) =>
    SHARED_GENRES.has(genre) ? genre : to === 'tv' ? DISCOVER_MOVIE_TO_TV[genre] : undefined;
  const genres: number[] = [];
  for (const genre of query.genres ?? []) {
    const mapped = map(genre);
    if (mapped === undefined) {
      if (query.genreJoin !== 'or') return undefined;
    } else if (!genres.includes(mapped)) genres.push(mapped);
  }
  // Nothing left to narrow by. A service query narrows by itself: its providers are a real filter.
  if (!genres.length && !query.keywords?.length && !query.watchProviders?.length) return undefined;
  const primaryGenre = query.primaryGenre === undefined ? undefined : map(query.primaryGenre);
  const withoutGenres = (query.withoutGenres ?? []).flatMap((genre) => map(genre) ?? []);
  return {
    ...query,
    mediaType: to,
    genres,
    primaryGenre,
    ...(query.withoutGenres ? { withoutGenres } : {}),
  };
}

/**
 * Film and TV origins, most catalog-rich first (DiscoveryCatalog.countries), each with the language its row is
 * predominantly in.
 *
 * The language is here for one purpose: not offering a row whose language the viewer has excluded. "Turkish
 * Series" with Turkish off drew a shelf of titles TMDB files under Turkey but tags as Urdu — so the hide rules,
 * which read the language, left every card in place and the row read as a wall of exactly what was unwanted.
 * It is never used to filter a title; a country is not a language, and the cards keep being judged by their own.
 *
 * India is deliberately left without one: excluding Hindi is not excluding Indian film, and there is no single
 * language that row is about.
 */
const COUNTRIES: [code: string, demonym: string, language?: string][] = [
  ['KR', 'Korean', 'ko'],
  ['JP', 'Japanese', 'ja'],
  ['ES', 'Spanish', 'es'],
  ['FR', 'French', 'fr'],
  ['GB', 'British', 'en'],
  ['IT', 'Italian', 'it'],
  ['IN', 'Indian'],
  ['DE', 'German', 'de'],
  ['SE', 'Swedish', 'sv'],
  ['DK', 'Danish', 'da'],
  ['BR', 'Brazilian', 'pt'],
  ['MX', 'Mexican', 'es'],
  ['CN', 'Chinese', 'zh'],
  ['TR', 'Turkish', 'tr'],
];

/** The language a country's row is predominantly in, for suppression only (`COUNTRIES`). */
const LANGUAGE_OF: Record<string, string> = Object.fromEntries(
  COUNTRIES.flatMap(([code, , language]) => (language ? [[code, language]] : [])),
);

interface Recipe {
  id: string;
  title: string;
  query: DiscoverQuery;
}

const movie = (query: Omit<DiscoverQuery, 'mediaType'>): DiscoverQuery => ({
  mediaType: 'movie',
  ...query,
});
const g = {
  action: 28,
  adventure: 12,
  comedy: 35,
  crime: 80,
  drama: 18,
  fantasy: 14,
  history: 36,
  horror: 27,
  mystery: 9648,
  romance: 10749,
  sciFi: 878,
  thriller: 53,
  war: 10752,
};

/** The TV's verified recipes (RecipeCatalog.all): genre blends, themes, regions, and Drama without the rest. */
export const RECIPES: Recipe[] = [
  {
    id: 'romantic-comedy',
    title: 'Romantic Comedy',
    query: movie({ genres: [g.comedy, g.romance], voteCountGte: 100 }),
  },
  {
    id: 'action-comedy',
    title: 'Action Comedy',
    query: movie({ genres: [g.action, g.comedy], voteCountGte: 100 }),
  },
  {
    id: 'horror-comedy',
    title: 'Horror Comedy',
    query: movie({ genres: [g.horror, g.comedy], voteCountGte: 50 }),
  },
  {
    id: 'sci-fi-horror',
    title: 'Sci-Fi Horror',
    query: movie({ genres: [g.sciFi, g.horror], voteCountGte: 50 }),
  },
  {
    id: 'sci-fi-action',
    title: 'Sci-Fi Action',
    query: movie({ genres: [g.sciFi, g.action], voteCountGte: 100 }),
  },
  {
    id: 'crime-thriller',
    title: 'Crime Thriller',
    query: movie({ genres: [g.crime, g.thriller], voteCountGte: 100 }),
  },
  {
    id: 'action-thriller',
    title: 'Action Thriller',
    query: movie({ genres: [g.action, g.thriller], voteCountGte: 150 }),
  },
  {
    id: 'romantic-drama',
    title: 'Romantic Drama',
    query: movie({ genres: [g.drama, g.romance], voteCountGte: 100 }),
  },
  {
    id: 'war-drama',
    title: 'War Drama',
    query: movie({ genres: [g.war, g.drama], voteCountGte: 80 }),
  },
  {
    id: 'historical-drama',
    title: 'Historical Drama',
    query: movie({ genres: [g.history, g.drama], voteCountGte: 80 }),
  },
  {
    id: 'fantasy-adventure',
    title: 'Fantasy Adventure',
    query: movie({ genres: [g.fantasy, g.adventure], voteCountGte: 100 }),
  },
  {
    id: 'crime-comedy',
    title: 'Crime Comedy',
    query: movie({ genres: [g.crime, g.comedy], voteCountGte: 80 }),
  },
  {
    id: 'police-procedural',
    title: 'Police Procedural',
    query: movie({ genres: [g.crime], keywords: [268067, 15167, 6149], voteCountGte: 80 }),
  },
  {
    id: 'heist',
    title: 'Heist',
    query: movie({
      genres: [g.crime, g.thriller],
      genreJoin: 'or',
      keywords: [10051],
      voteCountGte: 100,
    }),
  },
  {
    id: 'serial-killer',
    title: 'Serial Killer',
    query: movie({
      genres: [g.crime, g.thriller, g.horror],
      genreJoin: 'or',
      keywords: [10714],
      voteCountGte: 80,
    }),
  },
  {
    id: 'spy-espionage',
    title: 'Spy & Espionage',
    query: movie({
      genres: [g.thriller, g.action],
      genreJoin: 'or',
      keywords: [5265, 236615],
      voteCountGte: 80,
    }),
  },
  {
    id: 'assassin-hitman',
    title: 'Assassin & Hitman',
    query: movie({
      genres: [g.action, g.thriller],
      genreJoin: 'or',
      keywords: [782, 177964],
      voteCountGte: 80,
    }),
  },
  {
    id: 'time-travel',
    title: 'Time Travel',
    query: movie({ genres: [g.sciFi], keywords: [4379], voteCountGte: 80 }),
  },
  {
    id: 'cyberpunk',
    title: 'Cyberpunk',
    query: movie({ genres: [g.sciFi], keywords: [12190], voteCountGte: 40 }),
  },
  {
    id: 'zombie',
    title: 'Zombie',
    query: movie({ genres: [g.horror], keywords: [12377, 186565], voteCountGte: 60 }),
  },
  {
    id: 'slasher',
    title: 'Slasher',
    query: movie({ genres: [g.horror], keywords: [12339], voteCountGte: 40 }),
  },
  {
    id: 'superhero',
    title: 'Superhero',
    query: movie({
      genres: [g.action, g.adventure, g.sciFi],
      genreJoin: 'or',
      keywords: [9715],
      voteCountGte: 100,
    }),
  },
  {
    id: 'post-apocalyptic',
    title: 'Post-Apocalyptic',
    query: movie({
      genres: [g.sciFi, g.action],
      genreJoin: 'or',
      keywords: [4458, 4565],
      voteCountGte: 80,
    }),
  },
  {
    id: 'coming-of-age',
    title: 'Coming-of-Age',
    query: movie({ genres: [g.drama], keywords: [10683], voteCountGte: 80 }),
  },
  {
    id: 'courtroom-legal',
    title: 'Courtroom & Legal',
    query: movie({
      genres: [g.drama, g.thriller],
      genreJoin: 'or',
      keywords: [214780, 222517, 254459, 33519],
      voteCountGte: 50,
    }),
  },
  {
    id: 'martial-arts',
    title: 'Martial Arts',
    query: movie({ genres: [g.action], keywords: [779, 780, 9917], voteCountGte: 50 }),
  },
  {
    id: 'biopic',
    title: 'Biopic',
    query: movie({
      genres: [g.drama, g.history],
      genreJoin: 'or',
      keywords: [9672],
      voteCountGte: 80,
    }),
  },
  {
    id: 'mockumentary',
    title: 'Mockumentary',
    query: movie({ genres: [g.comedy], keywords: [11800], voteCountGte: 40 }),
  },
  {
    id: 'nordic-noir',
    title: 'Nordic Noir',
    query: movie({ genres: [g.crime], originalLanguage: 'sv|no|da|fi|is', voteCountGte: 30 }),
  },
  {
    id: 'k-drama',
    title: 'K-Drama',
    query: {
      mediaType: 'tv',
      genres: [g.drama],
      originalLanguage: 'ko',
      originCountry: ['KR'],
      voteCountGte: 50,
    },
  },
  {
    id: 'korean-thriller',
    title: 'Korean Thriller',
    query: movie({
      genres: [g.thriller, g.crime],
      genreJoin: 'or',
      originalLanguage: 'ko',
      originCountry: ['KR'],
    }),
  },
  {
    id: 'british-crime',
    title: 'British Crime',
    query: movie({ genres: [g.crime], originCountry: ['GB'], voteCountGte: 40 }),
  },
  {
    id: 'spanish-thriller',
    title: 'Spanish-language Thriller',
    query: movie({ genres: [g.thriller], originalLanguage: 'es', voteCountGte: 40 }),
  },
  {
    id: 'french-cinema',
    title: 'French Cinema',
    query: movie({ originalLanguage: 'fr', originCountry: ['FR'], voteCountGte: 60 }),
  },
  {
    id: 'italian-cinema',
    title: 'Italian Cinema',
    query: movie({ originalLanguage: 'it', originCountry: ['IT'], voteCountGte: 60 }),
  },
  {
    id: 'latin-american',
    title: 'Latin American',
    query: movie({
      originalLanguage: 'es|pt',
      originCountry: ['MX', 'AR', 'BR', 'CL', 'CO'],
      voteCountGte: 30,
    }),
  },
  {
    id: 'turkish-drama',
    title: 'Turkish Drama',
    query: { mediaType: 'tv', genres: [g.drama], originCountry: ['TR'] },
  },
  {
    id: 'j-horror',
    title: 'J-Horror',
    query: movie({ genres: [g.horror], originalLanguage: 'ja', originCountry: ['JP'] }),
  },
  {
    id: 'pure-drama',
    title: 'Pure Drama',
    query: movie({ genres: [g.drama], withoutGenres: [g.crime, g.mystery, g.thriller, g.horror] }),
  },
];

/** One row of the endless tail. */
export interface Category {
  id: string;
  title: string;
  query: DiscoverQuery;
}

/** One from each list in turn, until all drain — genre, recipe, decade, country, genre… */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++)
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  return out;
}

/**
 * The endless feed for one type (DiscoveryCatalog.categories, without the on-device index rows): genres with the
 * preferred first, the recipes for this type, the decades down to the 1950s, the countries — interleaved — then
 * Critically Acclaimed. `minYear` (the TV's year floor) bounds every row, and drops a decade wholly below it.
 */
/**
 * Is this row about nothing but languages the viewer has excluded?
 *
 * A row whose whole premise is one of them — "K-Drama" with Korean off — has every card hidden by the same
 * rules, so it draws a heading over an empty shelf and keeps asking TMDB for more of what it will not show.
 * A row that merely includes such a language among others keeps it: the rest of it still has titles.
 */
function onlyExcluded(query: DiscoverQuery, excluded: ReadonlySet<string>): boolean {
  if (!excluded.size) return false;
  const languages = query.originalLanguage?.split('|').filter(Boolean) ?? [];
  if (languages.length) return languages.every((code) => excluded.has(code));
  // A row that names no language but one origin country is about that country's language in practice —
  // "Turkish Drama" is `originCountry: ['TR']` and nothing else. That one matters: TMDB files those titles
  // under Turkey while tagging many of them Urdu, so the hide rules (which read the language) left every
  // card standing and the row filled with precisely what had been excluded.
  const countries = query.originCountry ?? [];
  const spoken = countries.flatMap((code) => LANGUAGE_OF[code] ?? []);
  return (
    spoken.length === countries.length && spoken.length > 0 && spoken.every((c) => excluded.has(c))
  );
}

export function categories(
  type: MediaType,
  currentYear: number,
  {
    preferredGenres = [] as number[],
    minYear = undefined as number | undefined,
    excludedLanguages = new Set<string>(),
  } = {},
): Category[] {
  const noun = type === 'tv' ? 'Series' : 'Movies';
  const dateGte = minYear ? `${minYear}-01-01` : undefined;
  const names = GENRES[type];
  const order = [
    ...new Set([
      ...preferredGenres,
      ...EXPLORE[type],
      ...Object.keys(names)
        .map(Number)
        .sort((a, b) => a - b),
    ]),
  ];
  const genres = order.flatMap((id): Category[] => {
    const name = names[id];
    return name
      ? [
          {
            id: `genre-${id}-${type}`,
            title: `${name} ${noun}`,
            query: {
              mediaType: type,
              genres: [id],
              primaryGenre: id,
              voteCountGte: 50,
              releaseDateGte: dateGte,
            },
          },
        ]
      : [];
  });
  const recipes = RECIPES.filter((r) => r.query.mediaType === type).map((r) => ({
    id: `recipe-${r.id}-${type}`,
    title: r.title,
    query: r.query,
  }));
  const decades: Category[] = [];
  for (let decade = Math.floor(currentYear / 10) * 10; decade >= 1950; decade -= 10) {
    if (minYear && decade + 9 < minYear) continue;
    decades.push({
      id: `decade-${decade}-${type}`,
      title: `${decade}s ${noun}`,
      query: {
        mediaType: type,
        voteCountGte: 50,
        releaseDateGte: `${Math.max(decade, minYear ?? decade)}-01-01`,
        releaseDateLte: `${decade + 9}-12-31`,
      },
    });
  }
  const countries = COUNTRIES.map(([code, demonym]) => ({
    id: `country-${code}-${type}`,
    title: `${demonym} ${noun}`,
    query: { mediaType: type, originCountry: [code], voteCountGte: 30, releaseDateGte: dateGte },
  }));
  const acclaimed = {
    id: `acclaimed-${type}`,
    title: 'Critically Acclaimed',
    query: {
      mediaType: type,
      voteCountGte: 300,
      releaseDateGte: dateGte,
      sortBy: 'vote_average.desc',
    },
  };
  // One rule, applied once at the end: a row about nothing but excluded languages is never offered, whether
  // it says so with a language or with the country that stands for one.
  return [...interleave<Category>([genres, recipes, decades, countries]), acclaimed].filter(
    (c) => !onlyExcluded(c.query, excludedLanguages),
  );
}

/** A row on a browse screen: its header now, its posters a page at a time. */
export interface RowDef {
  id: string;
  title: string;
  /** The named title/person within a contextual heading, and its destination. */
  headingLink?: { before: string; label: string; after: string; href: string };
  load: (page: number) => Promise<Title[]>;
  /** A shelf's semantic membership, applied after loading so an all-secondary page can be skipped. */
  filter?: (title: Title) => boolean;
  /**
   * What a card says under its name, where the year is not the useful thing. A row pooling several services says
   * which of them a title is on, and when it lands there.
   */
  caption?: (title: Title) => string | undefined;
}

/** One page of a TMDB list as titles. Rejects when TMDB doesn't answer; an empty page is the end. */
export type Pages = (
  path: string,
  type: MediaType,
  params: Record<string, string>,
  page: number,
) => Promise<Title[]>;

export function tmdbPages(key: string, fetchImpl: typeof fetch = tmdbFetch): Pages {
  return async (path, type, params, page) => {
    if (page > 500) return []; // TMDB serves no deeper
    const url = new URL(TMDB + path);
    for (const [name, value] of Object.entries({ ...params, page: String(page), api_key: key }))
      url.searchParams.set(name, value);
    const res = await fetchImpl(url.toString());
    if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
    const body = (await res.json()) as { results?: unknown };
    return (Array.isArray(body.results) ? body.results : []).flatMap((raw) => {
      const r = raw as Record<string, unknown>;
      return typeof r.id === 'number' ? (toTitle({ type, id: r.id }, r) ?? []) : [];
    });
  };
}

export const discoverRow = (
  pages: Pages,
  id: string,
  title: string,
  query: DiscoverQuery,
): RowDef => ({
  id,
  title,
  filter:
    query.primaryGenre === undefined
      ? undefined
      : (item) => matchesPrimaryGenre(item, query.primaryGenre!),
  load: (page) =>
    pages(`/discover/${query.mediaType}`, query.mediaType, discoverParams(query), page),
});

const day = (date: Date) => date.toISOString().slice(0, 10);

/** Home's curated recipe rows, below the spine (TMDBDiscovery.homeRecipeRows). */
const HOME_RECIPES = ['romantic-comedy', 'nordic-noir', 'police-procedural'];

/**
 * Home: the spine — trending, what became watchable lately, top series, upcoming — then its recipe rows, then movie
 * and series categories alternating. The tail leaves out what the head already shows.
 */
export function homeRows(
  pages: Pages,
  {
    now = new Date(),
    minYear = undefined as number | undefined,
    excludedLanguages = new Set<string>(),
  } = {},
): RowDef[] {
  const since = new Date(now.getTime() - 120 * 86_400_000);
  const spine: RowDef[] = [
    {
      id: 'trending',
      title: 'Trending This Week',
      load: (page) => pages('/trending/movie/week', 'movie', {}, page),
    },
    discoverRow(pages, 'new-releases', 'New Releases', {
      mediaType: 'movie',
      voteCountGte: 50,
      releaseDateGte: day(since),
      releaseDateLte: day(now),
      sortBy: 'primary_release_date.desc',
    }),
    {
      id: 'top-series',
      title: 'Top Rated Series',
      load: (page) => pages('/tv/top_rated', 'tv', {}, page),
    },
    {
      id: 'upcoming',
      title: 'Upcoming',
      load: (page) => pages('/movie/upcoming', 'movie', {}, page),
    },
  ];
  const recipes = HOME_RECIPES.flatMap((slug) => RECIPES.find((r) => r.id === slug) ?? [])
    .filter((r) => !onlyExcluded(r.query, excludedLanguages))
    .map((r) => discoverRow(pages, `recipe-${r.id}`, r.title, r.query));
  const year = now.getFullYear();
  const tail = interleave([
    categories('movie', year, { minYear, excludedLanguages }),
    categories('tv', year, { minYear, excludedLanguages }),
  ]).filter(
    (c) =>
      c.id !== 'acclaimed-tv' &&
      !HOME_RECIPES.some((slug) => c.id === `recipe-${slug}-movie` || c.id === `recipe-${slug}-tv`),
  );
  return [...spine, ...recipes, ...tail.map((c) => discoverRow(pages, c.id, c.title, c.query))];
}

/**
 * Home's personal rows, above the spine (HomeModel): "Because you watched X" for your latest watched or liked titles,
 * then "Because you added X to your Watchlist" — TMDB's recommendations for each, less what your library holds.
 */
export function personalRows(
  pages: Pages,
  { watched, watchlisted, owned }: { watched: Title[]; watchlisted: Title[]; owned: Set<string> },
): RowDef[] {
  const row = (id: string, before: string, after: string, seed: Title): RowDef => ({
    id: `${id}-${seed.type}-${seed.id}`,
    title: `${before}${seed.title}${after}`,
    headingLink: { before, label: seed.title, after, href: titleHref(seed) },
    load: async (page) =>
      (await pages(`/${seed.type}/${seed.id}/recommendations`, seed.type, {}, page)).filter(
        (t) => !owned.has(`${t.type}:${t.id}`),
      ),
  });
  return [
    ...watched.map((seed) => row('byw', 'Because you watched ', '', seed)),
    ...watchlisted.map((seed) => row('wl', 'Because you added ', ' to your Watchlist', seed)),
  ];
}

/**
 * The Movies or Series tab (BrowseModel): Popular, three genre rows from the TV's Explore order, then that type's
 * categories — none of them a genre already shown, or one the TV hides.
 */
export function browseRows(
  type: MediaType,
  pages: Pages,
  {
    now = new Date(),
    minYear = undefined as number | undefined,
    hiddenGenres = new Set<number>(),
    excludedLanguages = new Set<string>(),
  } = {},
): RowDef[] {
  const curated = EXPLORE[type].filter((id) => !hiddenGenres.has(id)).slice(0, 3);
  const popular: RowDef = {
    id: 'popular',
    title: 'Popular on TMDB',
    load: (page) => pages(`/${type}/popular`, type, {}, page),
  };
  const genreRows = curated.map((id) =>
    discoverRow(pages, `genre-${id}`, GENRES[type][id] ?? '', {
      mediaType: type,
      genres: [id],
      primaryGenre: id,
    }),
  );
  const tail = categories(type, now.getFullYear(), { minYear, excludedLanguages }).filter((c) => {
    const only = c.id.startsWith('genre-') ? c.query.genres?.[0] : undefined;
    return only === undefined || (!curated.includes(only) && !hiddenGenres.has(only));
  });
  return [popular, ...genreRows, ...tail.map((c) => discoverRow(pages, c.id, c.title, c.query))];
}
