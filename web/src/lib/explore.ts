// Search before anything is typed: the TV's Explore (SearchModel). A Movies/Series choice, then one chip open at a
// time — For You, a genre, a recipe or one of atlas's moods — and the one endless grid it fills. A chip is named by
// an id that lives in the address (`?c=`), so a view can be linked and Back returns to the chip before it.

import {
  appendUniqueTitles,
  categories,
  COUNTRIES,
  discoverRow,
  drawn,
  equivalentGenre,
  EXPLORE,
  GENRES,
  interleave,
  RECIPES,
  recipeParts,
  retargeted,
  type DiscoverQuery,
  type Pages,
  type RowDef,
} from './catalog';
import { atlasRows } from './atlasRows';
import {
  countedEmpty,
  filterItems,
  filterOnlyKind,
  type FacetCounts,
  type FilterOnlyKind,
} from './facetCounts';
import { filterTitles, FilterUnavailable, type FilterCounts } from './filterRoutes';
import type { MediaType, Title } from './library';
import { moreLikeThisRow } from './relatedRows';
import { FACET, likeOf } from './route';

export const FOR_YOU = 'for-you';

/**
 * What a chip is: For You, one of the kinds the rail lists and the search field finds, or — where atlas's filter
 * answers (`filterRoutes.ts`) — one of the kinds only it knows, listed from its counts (`filterChips`).
 */
export type ChipGroup =
  | 'for-you'
  | 'genre'
  | 'recipe'
  | 'mood'
  | 'language'
  | 'country'
  | 'region'
  | 'decade'
  | 'rating'
  | 'like'
  | 'people'
  | 'company'
  | 'network'
  | 'subject'
  | 'place'
  | 'format'
  | 'source'
  | 'technique'
  | 'audience'
  | 'critique'
  | 'runtime'
  | 'animated'
  | 'character';

export interface Chip {
  id: string;
  label: string;
  group: ChipGroup;
  /** Other names it is found by: a country by its people's name, a decade by "90s" and "nineties". */
  aliases?: string[];
  /** Its kind in words where the group's (`KIND`) says less: a person's "actor" or "director/writer". */
  kind?: string;
}

/** A chip's kind as a word, for the muted label beside a Browse-row chip: "Swedish · language". */
export const KIND: Record<ChipGroup, string> = {
  'for-you': '',
  mood: 'mood',
  recipe: 'recipe',
  genre: 'genre',
  language: 'language',
  country: 'country',
  region: 'region',
  decade: 'decade',
  rating: 'rating',
  like: 'like',
  people: 'person',
  company: 'studio',
  network: 'network',
  subject: 'subject',
  place: 'place',
  format: 'format',
  source: 'based on',
  technique: 'technique',
  audience: 'audience',
  critique: 'critique',
  runtime: 'runtime',
  animated: 'animation',
  character: 'character',
};

/** The rating floors offered, as the posters' ★ reads (TMDB's vote average), each with the words people use for it. */
const RATINGS: [floor: number, words: string[]][] = [
  [6, ['6+', 'decent', 'rated', 'rating']],
  [7, ['7+', 'good', 'rated', 'rating']],
  [8, ['8+', 'great', 'rated', 'rating']],
];
/**
 * The votes a rating must rest on to count toward a floor. Enough to keep out the single-vote 10/10s, low enough not
 * to empty a niche selection: Swedish 2020s romantic comedies at ★ 6+ are none at 100 votes, two at 10. With a
 * rating picked it takes the place of the feed's own vote floor (30, or 50 for a decade), which is there to stand in
 * for a quality floor that the rating now states.
 */
const RATING_VOTES = 10;

const ratingChips = (): Chip[] =>
  RATINGS.map(([floor, words]) => ({
    id: `rating-${floor}`,
    label: `★ ${floor}+`,
    group: 'rating',
    aliases: words,
  }));

/**
 * A "Like" as a chip, for the pill that shows it: it is picked from a poster, never listed, so no type's chips hold
 * it. `name` is the title's, once known.
 */
export const likeChip = (id: string, name?: string): Chip => ({
  id,
  label: name ? `Like ${name}` : 'Like…',
  group: 'like',
});

/** Languages a filter can find: those of the country rows, and a few catalogues rich enough to browse by. */
const LANGUAGES = [
  ...new Set([
    ...COUNTRIES.flatMap(([, , language]) => language ?? []),
    'hi',
    'no',
    'fi',
    'nl',
    'pl',
  ]),
];

const named = (type: 'language' | 'region', code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** A decade's other names: "90s", and "nineties" for the ones people say. */
const DECADE_WORDS: Record<number, string> = {
  1950: 'fifties',
  1960: 'sixties',
  1970: 'seventies',
  1980: 'eighties',
  1990: 'nineties',
  2000: 'noughties',
};

/**
 * Other names a chip is found by beyond its label and its people's name: the short forms people type. An exact one
 * counts at any length, so "uk" and "sf" find theirs though two letters find nothing else.
 */
const ALIASES: Record<string, string[]> = {
  'country-GB': ['uk', 'england'],
  'country-US': ['us', 'usa', 'america'],
  'country-KR': ['korea'],
  'genre-878': ['sf', 'sci-fi', 'scifi'],
  'genre-10765': ['sf', 'sci-fi', 'scifi'],
};

/**
 * Notable regions, each picked as `region-<slug>`: a label, the other names it is found by, and its countries of
 * origin (ISO 3166-1, as TMDB and atlas spell them). The same table as den-atlas's `crates/den-index/src/regions.rs`,
 * which its filter answers `region:<slug>` from; here it is what TMDB is asked for where atlas's filter isn't there.
 */
export const REGIONS: { slug: string; label: string; aliases: string[]; countries: string[] }[] = [
  {
    slug: 'nordic',
    label: 'Nordic',
    aliases: ['nordic', 'nordics'],
    countries: ['SE', 'NO', 'DK', 'FI', 'IS'],
  },
  {
    slug: 'scandinavian',
    label: 'Scandinavian',
    aliases: ['scandinavian', 'scandinavia', 'scandi'],
    countries: ['SE', 'NO', 'DK'],
  },
  {
    slug: 'british-irish',
    label: 'British & Irish',
    aliases: ['british isles', 'uk and ireland'],
    countries: ['GB', 'IE'],
  },
  {
    slug: 'slavic',
    label: 'Slavic',
    aliases: ['slavic', 'eastern european'],
    countries: ['RU', 'UA', 'BY', 'PL', 'CZ', 'SK', 'SI', 'HR', 'RS', 'BA', 'ME', 'MK', 'BG'],
  },
  { slug: 'north-american', label: 'North American', aliases: [], countries: ['US', 'CA'] },
  {
    slug: 'latin-american',
    label: 'Latin American',
    aliases: ['latin', 'latino', 'latin america', 'south american'],
    countries: [
      'MX',
      'GT',
      'BZ',
      'HN',
      'SV',
      'NI',
      'CR',
      'PA',
      'CU',
      'DO',
      'PR',
      'CO',
      'VE',
      'EC',
      'PE',
      'BO',
      'BR',
      'PY',
      'UY',
      'AR',
      'CL',
    ],
  },
  {
    slug: 'east-asian',
    label: 'East Asian',
    aliases: ['east asian', 'asian'],
    countries: ['JP', 'KR', 'CN', 'TW', 'HK'],
  },
  {
    slug: 'southeast-asian',
    label: 'Southeast Asian',
    aliases: [],
    countries: ['TH', 'VN', 'PH', 'ID', 'MY', 'SG', 'KH', 'LA', 'MM'],
  },
  {
    slug: 'south-asian',
    label: 'South Asian',
    aliases: ['indian subcontinent', 'desi'],
    countries: ['IN', 'PK', 'BD', 'LK', 'NP'],
  },
  {
    slug: 'middle-eastern',
    label: 'Middle Eastern',
    aliases: ['middle east', 'arab'],
    countries: [
      'TR',
      'IR',
      'IL',
      'SA',
      'AE',
      'QA',
      'KW',
      'BH',
      'OM',
      'JO',
      'LB',
      'SY',
      'IQ',
      'YE',
      'PS',
      'EG',
    ],
  },
  {
    slug: 'african',
    label: 'African',
    aliases: ['africa', 'nollywood'],
    countries: [
      'DZ',
      'AO',
      'BJ',
      'BW',
      'BF',
      'BI',
      'CM',
      'CV',
      'CF',
      'TD',
      'KM',
      'CG',
      'CD',
      'CI',
      'DJ',
      'EG',
      'GQ',
      'ER',
      'SZ',
      'ET',
      'GA',
      'GM',
      'GH',
      'GN',
      'GW',
      'KE',
      'LS',
      'LR',
      'LY',
      'MG',
      'MW',
      'ML',
      'MR',
      'MU',
      'MA',
      'MZ',
      'NA',
      'NE',
      'NG',
      'RW',
      'ST',
      'SN',
      'SC',
      'SL',
      'SO',
      'ZA',
      'SS',
      'SD',
      'TZ',
      'TG',
      'TN',
      'UG',
      'ZM',
      'ZW',
    ],
  },
  {
    slug: 'oceanian',
    label: 'Oceanian',
    aliases: ['australian', 'new zealand', 'oceania', 'aussie'],
    countries: ['AU', 'NZ'],
  },
];

const regionOf = (id: string) => REGIONS.find((r) => `region-${r.slug}` === id);

/**
 * The languages, countries, regions and decades Explore offers beside the rail's own kinds: the browse tail's
 * countries (and the US, which has no tail row), the regions, every decade it has, and the languages of those
 * countries and a few more.
 */
function vocabularyChips(type: MediaType, year: number, minYear?: number): Chip[] {
  const languages = LANGUAGES.map((code): Chip => ({
    id: `lang-${code}`,
    label: named('language', code),
    group: 'language',
  }));
  const countries = [...COUNTRIES, ['US', 'American'] as const].map(([code, demonym]): Chip => ({
    id: `country-${code}`,
    label: named('region', code),
    group: 'country',
    aliases: [demonym, ...(ALIASES[`country-${code}`] ?? [])],
  }));
  const regions = REGIONS.map(({ slug, label, aliases }): Chip => ({
    id: `region-${slug}`,
    label,
    group: 'region',
    aliases,
  }));
  const decades = categories(type, year, { minYear }).flatMap((category): Chip[] => {
    const decade = /^decade-(\d{4})-/.exec(category.id)?.[1];
    if (!decade) return [];
    const start = Number(decade);
    const aliases = [`${String(start % 100).padStart(2, '0')}s`, DECADE_WORDS[start] ?? ''];
    return [
      {
        id: `decade-${start}`,
        label: `${start}s`,
        group: 'decade',
        aliases: aliases.filter(Boolean),
      },
    ];
  });
  return [...languages, ...countries, ...regions, ...decades];
}

/** The TV's curated recipe chips (RecipeCatalog.exploreChips), in its order. */
const RECIPE_CHIPS = [
  'romantic-comedy',
  'crime-thriller',
  'action-thriller',
  'sci-fi-horror',
  'horror-comedy',
  'heist',
  'serial-killer',
  'spy-espionage',
  'superhero',
  'time-travel',
  'zombie',
  'nordic-noir',
  'k-drama',
  'british-crime',
  'korean-thriller',
  'pure-drama',
];

const recipeOf = (id: string) => RECIPES.find((recipe) => recipe.id === id);

/**
 * atlas's rows (`atlasRows.ts`) as chips, in its own order — strongest first. A mood or a plot facet ("Bittersweet
 * Endings") is a mood here; a subgenre ("Neo-Noir") sits with the recipes, which it is to a viewer. Named by the
 * row's own id, so one both types carry stays open across a switch. The label drops the "Movies"/"Series" the
 * heading ends with, since the toggle beside it already says.
 */
function atlasChips(type: MediaType): Chip[] {
  const suffix = `-${type}`;
  return atlasRows('', type).map((row) => {
    const id = row.id.slice('atlas-'.length, -suffix.length);
    return {
      id,
      label: row.title.replace(/ (Movies|Series)$/, ''),
      group: id.startsWith('subgenre-') ? 'recipe' : 'mood',
    };
  });
}

/** A label reduced to what two names for one thing share: "Serial Killers" is "Serial Killer". */
const same = (label: string) => fold(label).replace(/ /g, '').replace(/s$/, '');

/**
 * The chips for `type`, in the order they are offered: For You; atlas's moods; the recipes (the TV's curated
 * ones first, then the rest of the catalogue, then atlas's subgenres that no recipe already names); and the
 * genres, the TV's Explore order first, less the hidden ones. Moods and subgenres only where atlas answers. Then
 * the languages, countries and decades.
 */
export function exploreChips(
  type: MediaType,
  {
    hiddenGenres = new Set<number>(),
    atlas = false,
    year = new Date().getFullYear(),
    minYear = undefined as number | undefined,
  } = {},
): Chip[] {
  const recipeIds = [...new Set([...RECIPE_CHIPS, ...RECIPES.map((r) => r.id)])];
  const recipes = recipeIds.flatMap((id): Chip[] => {
    const recipe = recipeOf(id);
    return recipe && retargeted(recipe.query, type)
      ? [{ id: `recipe-${id}`, label: recipe.title, group: 'recipe' }]
      : [];
  });
  const fromAtlas = atlas ? atlasChips(type) : [];
  const named = new Set(recipes.map((r) => same(r.label)));
  const subgenres = fromAtlas.filter((c) => c.group === 'recipe' && !named.has(same(c.label)));
  const genreIds = [
    ...new Set([...EXPLORE[type], ...Object.keys(GENRES[type]).map(Number)]),
  ].filter((id) => !hiddenGenres.has(id));
  const genres = genreIds.map((id): Chip => ({
    id: `genre-${id}`,
    label: GENRES[type][id] ?? '',
    group: 'genre',
    ...(ALIASES[`genre-${id}`] ? { aliases: ALIASES[`genre-${id}`] } : {}),
  }));
  return [
    { id: FOR_YOU, label: 'For You', group: 'for-you' },
    ...fromAtlas.filter((c) => c.group === 'mood'),
    ...recipes,
    ...subgenres,
    ...genres,
    ...vocabularyChips(type, year, minYear),
    ...ratingChips(),
  ];
}

/** Case, accents and punctuation folded away, `&` read as "and": what a typed word is matched against. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words that name nothing on their own: "and" should not find "Slow-Burn and Bleak". */
const STOP = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'in',
  'on',
  'to',
  'for',
  'with',
  'you',
  'set',
]);
const words = (text: string) =>
  fold(text)
    .split(' ')
    .filter((word) => word && !STOP.has(word));

/**
 * What people type for a category that is named something else. Keys are folded words; values are chip ids, and
 * an id this type has no chip for is simply skipped. Small on purpose: the names match on their own.
 */
const SYNONYMS: Record<string, string[]> = {
  funny: ['genre-35', 'mood-feel-good', 'subgenre-dark-comedy'],
  scary: ['genre-27', 'subgenre-supernatural-horror', 'subgenre-folk-horror'],
  creepy: ['genre-27', 'subgenre-supernatural-horror', 'subgenre-folk-horror'],
  space: ['plot-space', 'genre-878', 'genre-10765'],
  sad: ['mood-tearjerker', 'plot-unhappy'],
  love: ['genre-10749', 'recipe-romantic-comedy', 'recipe-romantic-drama'],
  murder: ['subgenre-whodunit', 'recipe-serial-killer', 'recipe-police-procedural'],
  detective: ['subgenre-whodunit', 'recipe-police-procedural'],
  cartoon: ['genre-16'],
  kids: ['genre-10751', 'genre-10762'],
  weird: ['mood-quirky', 'plot-dreamlike'],
};

/**
 * The Damerau–Levenshtein distance (optimal string alignment) between two words, or `limit + 1` once it is clear
 * it exceeds `limit`: a swapped pair of letters ("sweidsh") costs one edit, as a typo does.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, before[j - 2]! + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = row;
  }
  return previous[b.length]!;
}

/** How far a typed word may be from a name and still be taken for it: none under three letters. */
const tolerance = (word: string) => (word.length < 3 ? 0 : word.length < 6 ? 1 : 2);
const near = (typed: string, word: string) =>
  tolerance(typed) > 0 && editDistance(typed, word, tolerance(typed)) <= tolerance(typed);

/**
 * How well a chip matches, best first: the whole name, its start, a word's start, a synonym, then a near miss —
 * the whole name ("acton" for Action) before one of its words (Action Thriller).
 */
const EXACT = 0;
const PREFIX = 1;
const WORD = 2;
const SYNONYM = 3;
const FUZZY_NAME = 4;
const FUZZY = 5;

/**
 * The chips `text` names, as one list ranked by how well each matches — the whole name, then its start, then a
 * word's start, then a synonym, then a name one or two typos away — and in the chips' own order within a rank. A
 * name is a chip's label or one of its aliases, and For You is never one. `minWord` leaves out words too short to
 * mean anything, which a filter being typed into wants (1) and a suggestion drawn from a whole query does not (3).
 */
export function matchChips(text: string, chips: Chip[], { minWord = 1 } = {}): Chip[] {
  const phrase = fold(text);
  if (!phrase) return [];
  // Too short to match any other way, a phrase can still be a whole name: "7+" is "★ 7+".
  const short = phrase.length < minWord;
  const typed = words(text).filter((word) => word.length >= minWord);
  const synonym = new Set(typed.flatMap((word) => SYNONYMS[word] ?? []));
  const nearSynonym = new Set(
    typed.flatMap((word) =>
      Object.entries(SYNONYMS).flatMap(([key, ids]) => (near(word, key) ? ids : [])),
    ),
  );
  const rank = (chip: Chip): number | undefined => {
    const names = [chip.label, ...(chip.aliases ?? [])].map(fold);
    if (names.includes(phrase)) return EXACT;
    if (short) return undefined;
    if (names.some((name) => name.startsWith(phrase))) return PREFIX;
    const nameWords = names.flatMap((name) => words(name));
    if (nameWords.some((word) => typed.some((t) => word.startsWith(t)))) return WORD;
    if (synonym.has(chip.id)) return SYNONYM;
    if (names.some((name) => near(phrase, name))) return FUZZY_NAME;
    if (nameWords.some((word) => typed.some((t) => near(t, word)))) return FUZZY;
    if (nearSynonym.has(chip.id)) return FUZZY;
    return undefined;
  };
  return chips
    .filter((chip) => chip.group !== 'for-you')
    .flatMap((chip, at) => {
      const score = rank(chip);
      return score === undefined ? [] : [{ chip, score, at }];
    })
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .map(({ chip }) => chip);
}

/**
 * The ways to browse a typed query points at, offered above its results: instant, local, from two letters, best
 * match first — the whole query as a name ("uk", "sweden") before anything it merely begins.
 */
export function browseChips(query: string, chips: Chip[]): Chip[] {
  const found = matchChips(query, chips, { minWord: 2 });
  // A query of several words is more likely a title than a category: only the closest few.
  return words(query).length >= 3 ? found.slice(0, 3) : found;
}

/** Whether `text` is this chip's whole name, or one of its other names. */
export const namesExactly = (text: string, chip: Chip) =>
  [chip.label, ...(chip.aliases ?? [])].map(fold).includes(fold(text));

// Facets. What is picked stacks: Sweden, then + Action, is Swedish action films. A selection is a list of chip ids
// in the order picked, For You being the empty one. Each kind fills one slot but the genres, which all apply together.
// A recipe picked over another takes its slot; the other kinds hold one value, and offer no other until it is removed.

/**
 * Which slot a facet fills. A mood, a plot facet and a subgenre are all atlas's rows, and fill one slot. A "Like" —
 * the titles closest to one title — is atlas's too, and can't share a feed with a mood, but is its own kind. The
 * kinds only atlas's filter knows stack as genres do (`more`: people, studios, subjects…), but a runtime and whether
 * it is animated, which a title has one of.
 */
export type Slot =
  | 'genre'
  | 'language'
  | 'country'
  | 'region'
  | 'decade'
  | 'rating'
  | 'recipe'
  | 'atlas'
  | 'like'
  | 'runtime'
  | 'animated'
  | 'more';

/** The slots that hold one value: once it is picked, no other of its kind is offered until it is removed. */
const SINGLE: ReadonlySet<Slot | undefined> = new Set<Slot>([
  'language',
  'country',
  'region',
  'decade',
  'rating',
  'atlas',
  'like',
  'runtime',
  'animated',
]);

/** The slots whose values all apply together. */
const stacks = (slot: Slot | undefined) => slot === 'genre' || slot === 'more';

export function slotOf(id: string): Slot | undefined {
  if (id === FOR_YOU) return undefined;
  if (likeOf(id)) return 'like';
  const only = filterOnlyKind(id);
  if (only) return only === 'runtime' || only === 'animated' ? only : 'more';
  if (id.startsWith('genre-')) return 'genre';
  if (id.startsWith('lang-')) return 'language';
  if (id.startsWith('country-')) return 'country';
  if (id.startsWith('region-')) return 'region';
  if (id.startsWith('decade-')) return 'decade';
  if (id.startsWith('rating-')) return 'rating';
  if (id.startsWith('recipe-')) return 'recipe';
  return 'atlas';
}

const genreOf = (id: string) => Number(id.slice('genre-'.length));
const decadeOf = (id: string) => Number(id.slice('decade-'.length));
const ratingOf = (id: string) => Number(id.slice('rating-'.length));
/** `sv` from `lang-sv`, `SE` from `country-SE`. */
const codeOf = (id: string) => id.slice(id.indexOf('-') + 1);
const recipeQuery = (id: string, type: MediaType) => {
  const recipe = recipeOf(id.slice('recipe-'.length));
  return recipe && retargeted(recipe.query, type);
};

/**
 * Whether two facets can't stand together. Two of one slot can't — the newer takes it — but genres can. An atlas row
 * says which genres, language and year each title has, and nothing about its country or a recipe's keywords, so a
 * mood or a "Like" takes neither — nor each other, since each is a whole feed. A mood's titles carry no rating
 * either, where a "Like"'s, drawn from TMDB, do. A recipe can't take a language, a country or a genre its own query
 * rules out.
 *
 * Where atlas's filter answers (`filtered`), it takes any mix of what it knows, so all that is lifted: what it can't
 * take is a recipe it has no form of (`recipeParts`) beside a kind only it knows.
 */
function clash(a: string, b: string, type: MediaType, filtered = false): boolean {
  const [sa, sb] = [slotOf(a), slotOf(b)];
  if (sa === sb) return !stacks(sa);
  const fromAtlas = (slot: Slot | undefined) =>
    slot === 'atlas' ||
    slot === 'like' ||
    slot === 'more' ||
    slot === 'runtime' ||
    slot === 'animated';
  const tmdbOnly = (id: string) =>
    slotOf(id) === 'recipe' && !recipeParts(id.slice('recipe-'.length), type);
  if (filtered) {
    if ((tmdbOnly(a) && fromAtlas(sb)) || (tmdbOnly(b) && fromAtlas(sa))) return true;
  } else if (fromAtlas(sa) || fromAtlas(sb)) {
    const [feed, other] = fromAtlas(sa) ? [sa, sb] : [sb, sa];
    return (
      other === 'country' ||
      other === 'region' ||
      other === 'recipe' ||
      fromAtlas(other) ||
      (other === 'rating' && feed === 'atlas')
    );
  }
  if (sa !== 'recipe' && sb !== 'recipe') return false;
  const [recipe, other] = sa === 'recipe' ? [a, b] : [b, a];
  const query = recipeQuery(recipe, type);
  if (!query) return true;
  switch (slotOf(other)) {
    case 'language':
      return !!query.originalLanguage && !query.originalLanguage.split('|').includes(codeOf(other));
    case 'country':
      return !!query.originCountry?.length && !query.originCountry.includes(codeOf(other));
    case 'region':
      return (
        !!query.originCountry?.length &&
        !regionOf(other)?.countries.some((code) => query.originCountry!.includes(code))
      );
    case 'genre':
      return (query.withoutGenres ?? []).includes(genreOf(other));
    default:
      return false;
  }
}

/**
 * The selection once `id` is picked: For You empties it, a facet already in it comes out, and anything else goes in
 * last — taking out whatever it can't stand beside, which is `removed`: the newer pick wins.
 */
export function applyPick(
  set: readonly string[],
  id: string,
  type: MediaType,
  filtered = false,
): { set: string[]; removed: string[] } {
  if (id === FOR_YOU) return { set: [], removed: [] };
  if (set.includes(id)) return { set: set.filter((x) => x !== id), removed: [] };
  const removed = set.filter((x) => clash(x, id, type, filtered));
  return { set: [...set.filter((x) => !removed.includes(x)), id], removed };
}

/** Whether `id`'s kind holds one value and the selection already has another: it can't be picked until that goes. */
export function taken(set: readonly string[], id: string): boolean {
  const slot = slotOf(id);
  return SINGLE.has(slot) && set.some((x) => x !== id && slotOf(x) === slot);
}

/**
 * Whether a chip is worth offering beside the selection: not one already picked, not another of a one-value kind
 * already picked (`taken`), and not one that would throw out a pick of another kind. Another recipe still is: it
 * takes over the one picked.
 */
export function offered(
  set: readonly string[],
  id: string,
  type: MediaType,
  filtered = false,
): boolean {
  if (id === FOR_YOU) return true;
  if (set.includes(id) || taken(set, id)) return false;
  return !set.some((x) => slotOf(x) !== slotOf(id) && clash(x, id, type, filtered));
}

/**
 * The selection under the other type (SearchModel.setScope, for every facet): a genre moves to its closest
 * counterpart, and anything the new type has no chip for — a recipe with no series form, a mood only films carry, a
 * "Like" for a title of the other type — is `dropped`.
 */
export function remapSet(
  set: readonly string[],
  from: MediaType,
  to: MediaType,
  chips: Chip[],
): { set: string[]; dropped: string[] } {
  const known = new Set(chips.map((chip) => chip.id));
  for (const id of set) if (likeOf(id)?.type === to) known.add(id);
  // A person, a studio, a subject… is the same for either type; a network only a series has.
  for (const id of set)
    if (filterOnlyKind(id) && !(to === 'movie' && filterOnlyKind(id) === 'network')) known.add(id);
  const next: string[] = [];
  const dropped: string[] = [];
  for (const id of set) {
    const moved =
      from !== to && slotOf(id) === 'genre'
        ? `genre-${equivalentGenre(genreOf(id), from, to) ?? ''}`
        : id;
    if (known.has(moved) && !next.includes(moved)) next.push(moved);
    else if (!known.has(moved)) dropped.push(id);
  }
  return { set: next, dropped };
}

/** The genre `chip` is for `from`, remapped: what `remapSet` does for one chip, For You where nothing fits. */
export function remapChip(chip: string, from: MediaType, to: MediaType, chips: Chip[]): string {
  return remapSet([chip], from, to, chips).set[0] ?? FOR_YOU;
}

/**
 * The one TMDB discover query a selection of TMDB facets is — undefined for none, or for one with an atlas row in it.
 *
 * A recipe is a preset: its own query goes in first, and the other facets add to it. Genres AND together, with a
 * recipe's own where it joins them the same way; an OR-joined recipe (Heist is Crime or Thriller, with its keyword)
 * can't be ANDed with more in TMDB's one genre parameter, so its keyword carries it and its genres give way. A
 * genre alone is its browse row's shelf, kept to titles that are that genre first (`primaryGenre`).
 */
export function facetQuery(
  set: readonly string[],
  type: MediaType,
  minYear?: number,
): DiscoverQuery | undefined {
  const tmdb = (id: string) => {
    const slot = slotOf(id);
    return !(slot === 'atlas' || slot === 'like' || filterOnlyKind(id));
  };
  if (!set.length || !set.every(tmdb)) return undefined;
  const genres = set.filter((id) => slotOf(id) === 'genre').map(genreOf);
  const recipe = set.find((id) => slotOf(id) === 'recipe');
  const language = set.find((id) => slotOf(id) === 'language');
  const country = set.find((id) => slotOf(id) === 'country');
  const region = set.find((id) => slotOf(id) === 'region');
  const decade = set.find((id) => slotOf(id) === 'decade');
  const rating = set.find((id) => slotOf(id) === 'rating');
  const preset = recipe ? recipeQuery(recipe, type) : undefined;
  const query: DiscoverQuery = {
    ...preset,
    mediaType: type,
    primaryGenre: undefined,
    voteCountGte: Math.max(decade ? 50 : 30, preset?.voteCountGte ?? 0),
  };
  if (genres.length) {
    const own = preset && preset.genreJoin !== 'or' ? (preset.genres ?? []) : [];
    query.genres = [...new Set([...own, ...genres])];
    query.genreJoin = 'and';
  }
  if (set.length === 1 && genres.length === 1) {
    query.primaryGenre = genres[0];
    query.voteCountGte = 50;
  }
  if (language) query.originalLanguage = codeOf(language);
  // A region is any of its countries (TMDB ORs them); a country picked beside it is narrower, and is all that's asked.
  if (country) query.originCountry = [codeOf(country)];
  else if (region) query.originCountry = [...(regionOf(region)?.countries ?? [])];
  if (decade) {
    const start = decadeOf(decade);
    query.releaseDateGte = `${Math.max(start, minYear ?? start)}-01-01`;
    query.releaseDateLte = `${start + 9}-12-31`;
  } else if (minYear) {
    query.releaseDateGte = `${minYear}-01-01`;
  }
  if (rating) {
    query.voteAverageGte = ratingOf(rating);
    query.voteCountGte = Math.max(preset?.voteCountGte ?? 0, RATING_VOTES);
  }
  return query;
}

/**
 * What an atlas row keeps once the rest of the selection applies to it, on the fields its titles carry: every genre,
 * the language, the decade, and — for a "Like", whose titles TMDB draws — the rating, on the votes TMDB's own floor
 * asks for. (A country and a recipe never share a selection with it, nor a rating a mood: `clash`.)
 */
function atlasFilter(set: readonly string[]): (title: Title) => boolean {
  const genres = set.filter((id) => slotOf(id) === 'genre').map(genreOf);
  const language = set.find((id) => slotOf(id) === 'language');
  const decade = set.find((id) => slotOf(id) === 'decade');
  const rating = set.find((id) => slotOf(id) === 'rating');
  return (title) =>
    genres.every((genre) => title.genreIds?.includes(genre)) &&
    (!language || title.originalLanguage === codeOf(language)) &&
    (!decade ||
      (title.year !== undefined &&
        title.year >= decadeOf(decade) &&
        title.year <= decadeOf(decade) + 9)) &&
    (!rating || ((title.rating ?? 0) >= ratingOf(rating) && (title.votes ?? 0) >= RATING_VOTES));
}

/**
 * The options that would show nothing beside `selection`. The one place the rail learns what is empty.
 *
 * Where atlas answered with its counts (`filterRoutes.ts`), an option with none in a kind it lists completely is
 * empty. And
 * once the selection's own feed is `complete` (every page loaded), what is loaded is all there is: a genre, a rating,
 * or a language or a decade where none is picked yet, that nothing in it matches is empty too.
 *
 * A feed narrowed here rather than by TMDB — a mood's row, a "Like" — is judged by what it has loaded so far,
 * complete or not: nothing but its loaded titles says what it holds (atlas's similar list is ids alone), and an option
 * none of them matches is a dead end more often than not. One comes back as soon as a title loaded later matches it.
 *
 * Neither judges an option of a kind already picked — another recipe, which takes over the one picked, or another
 * country, which isn't offered at all (`taken`) — since it would replace what they were counted beside.
 */
export function emptyOptions(
  selection: readonly string[],
  loaded: readonly Title[],
  complete: boolean,
  chips: Chip[],
  { counts, type = 'movie' }: { counts?: FacetCounts | null; type?: MediaType } = {},
): Set<string> {
  const empty = new Set<string>();
  const picked = new Set(selection.map(slotOf));
  const judged = complete || ((picked.has('atlas') || picked.has('like')) && loaded.length > 0);
  for (const chip of chips) {
    const slot = slotOf(chip.id);
    if (!slot || selection.includes(chip.id)) continue;
    // A one-value kind's other values are the alternative pick, never judged beside the pick itself.
    const replaces = !stacks(slot) && picked.has(slot);
    if (replaces) continue;
    // atlas's counts, where it answered, are the whole judgement: the feed's loaded titles are the fallback.
    if (counts) {
      if (countedEmpty(chip.id, type, counts)) empty.add(chip.id);
      continue;
    }
    const narrows =
      slot === 'genre' || slot === 'language' || slot === 'decade' || slot === 'rating';
    if (judged && selection.length && narrows && !loaded.some(atlasFilter([chip.id])))
      empty.add(chip.id);
  }
  return empty;
}

/** The chips of `ids`, in that order, less any this type doesn't have. */
export const chipsOf = (ids: readonly string[], chips: Chip[]) =>
  ids.flatMap((id) => chips.find((chip) => chip.id === id) ?? []);

export interface FeedSources {
  pages: Pages;
  /** Where atlas answers; null leaves the mood chips out. */
  atlas: string | null;
  /** The library's latest titles, For You's seeds. */
  seeds: Title[];
  /** Every title the library holds, by `type:id`: For You doesn't suggest them. */
  owned: ReadonlySet<string>;
  /** Settings' release-year floor, applied to a genre as its browse row applies it. */
  minYear?: number;
  /** A title as TMDB draws it (`SearchSources.title`), for an atlas title with no poster. */
  title?: (ref: { type: MediaType; id: number }) => Promise<Title | null>;
  /** TMDB's key, or the empty string where den-edge lends its own: a "Like" draws its titles with it. */
  key?: string;
  /** How atlas's filter is asked (den-edge's relay by default). */
  fetchImpl?: typeof fetch;
}

/** How many of atlas's closest titles a "Like" asks for: all it keeps for one title. */
const LIKE_DEPTH = 200;

/** How many of the library's titles For You asks TMDB about, as the TV does (`maxSeeds: 3`). */
const SEEDS = 3;

/**
 * For You (SearchModel.exploreSuggestions): TMDB's recommendations for the library's latest few titles of this
 * type, first, then the popular movies or top-rated series as the endless tail. With no library, or nothing
 * recommended, it is the tail alone.
 */
function forYou(type: MediaType, { pages, seeds, owned }: FeedSources): RowDef {
  let personal: Promise<Title[]> | undefined;
  const recommended = () =>
    (personal ??= Promise.all(
      seeds
        .filter((seed) => seed.type === type)
        .slice(0, SEEDS)
        .map((seed) =>
          pages(`/${seed.type}/${seed.id}/recommendations`, seed.type, {}, 1).catch(
            (error: unknown): Title[] => {
              console.warn(
                'explore: For You has no recommendations for',
                `${seed.type}:${seed.id}`,
                error,
              );
              return [];
            },
          ),
        ),
    ).then((lists) =>
      appendUniqueTitles([], interleave(lists)).filter((t) => !owned.has(`${t.type}:${t.id}`)),
    ));
  const tail = (page: number) =>
    type === 'tv'
      ? pages('/tv/top_rated', 'tv', {}, page)
      : pages('/movie/popular', 'movie', {}, page);
  return {
    id: `${FOR_YOU}-${type}`,
    title: 'For You',
    load: async (page) => {
      const mine = await recommended();
      if (!mine.length) return tail(page);
      return page === 1 ? mine : tail(page - 1);
    },
  };
}

/**
 * What a selection shows for `type`, a page at a time: For You when it is empty; an atlas row or a "Like", filtered
 * here by the facets beside it, when it holds one; otherwise the one discover query its facets are.
 *
 * Where every pick has a form in atlas's filter (`filterItems`), the feed is its `titles.json`: one question, answered
 * in full, whatever the mix. Where atlas has no such route, or leaves a picked kind out, the feed goes on as it did
 * before it, from the page it had reached:
 *
 * A "Like" is the title page's "More like this" (`moreLikeThisRow`) as a whole feed: atlas's closest titles, then its
 * plot neighbours, then TMDB's recommendations for as many pages as TMDB has.
 */
export function exploreFeed(set: readonly string[], type: MediaType, sources: FeedSources): RowDef {
  if (!set.length) return forYou(type, sources);
  const id = `facets-${[...set].sort().join('+')}-${type}`;
  const local = localFeed(set, type, sources, id);
  const items = sources.atlas ? filterItems(set, type) : undefined;
  if (!sources.atlas || !items) return local;
  // atlas's cards, like its rows', are drawn where no poster is known yet; the fallback's rows draw their own.
  const titles = drawn(
    {
      id,
      title: '',
      load: filterTitles(sources.atlas, type, items, { fetchImpl: sources.fetchImpl }),
    },
    sources.title,
  );
  /** The page the fallback took over after; undefined while atlas's filter answers. */
  let from: number | undefined;
  return {
    id,
    title: '',
    // atlas's answer is the selection already; the fallback's needs its own narrowing.
    filter: (title) => from === undefined || (local.filter?.(title) ?? true),
    load: async (page) => {
      if (from === undefined) {
        try {
          return await titles.load(page);
        } catch (error) {
          if (!(error instanceof FilterUnavailable)) throw error;
          if (error.deployed) console.warn('explore: atlas filter gave way:', error.message, id);
          from = page - 1;
        }
      }
      return local.load(page - from);
    },
  };
}

/** A feed with nothing in it: a pick only atlas's filter can answer, where it doesn't. */
const nothing = (id: string): RowDef => ({ id, title: '', load: async () => [] });

/** What a selection shows without atlas's filter: a "Like", an atlas row, or a TMDB discover query. */
function localFeed(
  set: readonly string[],
  type: MediaType,
  sources: FeedSources,
  id: string,
): RowDef {
  if (set.some((pick) => filterOnlyKind(pick))) return nothing(id);
  const like = set.map(likeOf).find((ref) => ref !== undefined);
  if (like) {
    const row = moreLikeThisRow({ title: { ...like, title: '' } }, sources.atlas, {
      key: sources.key ?? '',
      similarLimit: LIKE_DEPTH,
    });
    return { ...row, id, filter: atlasFilter(set) };
  }
  const atlasId = set.find((pick) => slotOf(pick) === 'atlas');
  if (atlasId) {
    const row = sources.atlas
      ? atlasRows(sources.atlas, type).find((r) => r.id === `atlas-${atlasId}-${type}`)
      : undefined;
    if (!row) return forYou(type, sources);
    return { ...drawn(row, sources.title), id, filter: atlasFilter(set) };
  }
  const query = facetQuery(set, type, sources.minYear);
  return query ? discoverRow(sources.pages, id, '', query) : forYou(type, sources);
}

/** A runtime bucket's or an animation value's words; any other id of atlas's, as words. */
function valueLabel(kind: string, id: string): string {
  const runtime: Record<string, string> = {
    'under-90': 'Under 90 min',
    '90-120': '90–120 min',
    '120-150': '120–150 min',
    'over-150': 'Over 150 min',
  };
  if (kind === 'runtime' && runtime[id]) return runtime[id];
  if (kind === 'animated') return id === 'yes' ? 'Animated' : 'Not animated';
  const words = id.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The groups the filter-only kinds are listed under, in the rail's order. */
const FILTER_GROUPS: [FilterOnlyKind, ChipGroup][] = [
  ['person', 'people'],
  ['company', 'company'],
  ['network', 'network'],
  ['subject', 'subject'],
  ['place', 'place'],
  ['format', 'format'],
  ['source', 'source'],
  ['technique', 'technique'],
  ['audience', 'audience'],
  ['critique', 'critique'],
  ['runtime', 'runtime'],
  ['animated', 'animated'],
];

/** An id that can travel in the address (`route.ts`'s `c=`). */
const addressable = (id: string) => FACET.test(id);

/**
 * The options only atlas's filter knows, from its counts beside the selection: its top people, studios, subjects and
 * the rest, most titles first, named by its labels. Every one listed has titles beside the selection — atlas leaves
 * out a value with none — and the picked ones are there too, which is where their pills find their names.
 */
export function filterChips(counts: FilterCounts): Chip[] {
  const unavailable = new Set(counts.kindsUnavailable);
  const chips: Chip[] = [];
  // A maker, a cast member and a character are picked from the search field, never listed: only their names are
  // wanted here, for the pills.
  const namedOnly: [FilterOnlyKind, ChipGroup][] = [
    ['made', 'people'],
    ['cast', 'people'],
    ['character', 'character'],
  ];
  for (const [kind, group] of [...FILTER_GROUPS, ...namedOnly]) {
    const answer = counts.kinds[kind];
    if (!answer || unavailable.has(kind)) continue;
    const listed = !namedOnly.some(([k]) => k === kind);
    const ids = [
      ...new Set([
        ...(listed
          ? Object.entries(answer.values ?? {})
              .sort(([, a], [, b]) => b - a)
              .map(([value]) => value)
          : []),
        ...(answer.selected ?? []),
      ]),
    ];
    for (const value of ids) {
      const id = `${kind}-${value}`;
      if (!addressable(id)) continue;
      chips.push({ id, label: answer.labels?.[value] ?? valueLabel(kind, value), group });
    }
  }
  return chips;
}

/** A pick of a kind only atlas's filter knows, before its counts have named it: "Person…". */
export function pendingChip(id: string): Chip | undefined {
  const kind = filterOnlyKind(id);
  if (!kind) return undefined;
  const group =
    FILTER_GROUPS.find(([k]) => k === kind)?.[1] ?? (kind === 'character' ? 'character' : 'people');
  if (kind === 'runtime' || kind === 'animated') {
    return { id, label: valueLabel(kind, id.slice(kind.length + 1)), group };
  }
  const word = KIND[group];
  return { id, label: `${word.charAt(0).toUpperCase()}${word.slice(1)}…`, group };
}

/**
 * Queries to try, for someone who hasn't typed: atlas reads a mood, a theme or a place and era as well as a
 * title, and nothing on the page says so until one is tried.
 */
export const PROMPTS = [
  'funny heist',
  'slow-burn and bleak',
  '80s korean horror',
  'feel-good sports underdog',
  'mind-bending sci-fi',
];
