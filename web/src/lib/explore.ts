// Search before anything is typed: the TV's Explore (SearchModel). A Movies/Series choice, then one chip open at a
// time — For You, a genre, a recipe or one of atlas's moods — and the one endless grid it fills. A chip is named by
// an id that lives in the address (`?c=`), so a view can be linked and Back returns to the chip before it.

import {
  appendUniqueTitles,
  categories,
  COUNTRIES,
  discoverRow,
  equivalentGenre,
  EXPLORE,
  GENRES,
  interleave,
  RECIPES,
  retargeted,
  type Pages,
  type RowDef,
} from './catalog';
import { atlasRows } from './atlasRows';
import type { MediaType, Title } from './library';

export const FOR_YOU = 'for-you';

/**
 * What a chip is. The first four are the rail's; a language, a country and a decade are there to be found by the
 * filter ("swedish", "90s") and are never listed on their own — there are too many, and they say little alone.
 */
export type ChipGroup = 'for-you' | 'genre' | 'recipe' | 'mood' | 'language' | 'country' | 'decade';

export interface Chip {
  id: string;
  label: string;
  group: ChipGroup;
  /** Other names it is found by: a country by its people's name, a decade by "90s" and "nineties". */
  aliases?: string[];
}

/** A chip's kind as a word, for the muted label beside a filter result: "Swedish · language". */
export const KIND: Record<ChipGroup, string> = {
  'for-you': '',
  mood: 'mood',
  recipe: 'recipe',
  genre: 'genre',
  language: 'language',
  country: 'country',
  decade: 'decade',
};

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
 * The languages, countries and decades the filter finds, feeding what the browse tail already offers: a country
 * and a decade are its rows (`categories()`), so they carry its vote floors and the year floor; a language is TMDB's
 * `with_original_language`.
 */
function vocabularyChips(type: MediaType, year: number, minYear?: number): Chip[] {
  const languages = LANGUAGES.map((code): Chip => ({
    id: `lang-${code}`,
    label: named('language', code),
    group: 'language',
  }));
  const countries = COUNTRIES.map(([code, demonym]): Chip => ({
    id: `country-${code}`,
    label: named('region', code),
    group: 'country',
    aliases: [demonym],
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
  return [...languages, ...countries, ...decades];
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
 * the languages, countries and decades only the filter shows.
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
  }));
  return [
    { id: FOR_YOU, label: 'For You', group: 'for-you' },
    ...fromAtlas.filter((c) => c.group === 'mood'),
    ...recipes,
    ...subgenres,
    ...genres,
    ...vocabularyChips(type, year, minYear),
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
  sad: ['mood-tearjerker', 'plot-tragic', 'plot-bittersweet'],
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
  if (phrase.length < minWord) return [];
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

/** Categories a typed query points at, to open instead of searching: instant, local, a handful. */
export const suggestChips = (query: string, chips: Chip[]) =>
  matchChips(query, chips, { minWord: 3 }).slice(0, 6);

/**
 * The chip that is open once the type changes (SearchModel.setScope): a genre moves to its closest counterpart, a
 * recipe and a mood stay where the new type has them, and anything else falls back to For You rather than
 * leaving a chip open that can show nothing.
 */
export function remapChip(chip: string, from: MediaType, to: MediaType, chips: Chip[]): string {
  if (from === to) return chip;
  const genre = /^genre-(\d+)$/.exec(chip)?.[1];
  const next =
    genre === undefined ? chip : `genre-${equivalentGenre(Number(genre), from, to) ?? ''}`;
  return chips.some((c) => c.id === next) ? next : FOR_YOU;
}

/** The chip `id` names among `chips`, or For You when it names none of them. */
export const openChip = (id: string | undefined, chips: Chip[]): Chip =>
  chips.find((chip) => chip.id === id) ?? chips[0]!;

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
}

/**
 * atlas lists a title by id and name, and its poster only where some browser has already told den-edge
 * (`withSharedTitleMetadata`). A card with no poster is hidden, so without this a mood is mostly empty. The ones
 * still missing are looked up, as search's `drawable` does; one TMDB can't name stays as it was.
 */
function drawn(row: RowDef, title: FeedSources['title']): RowDef {
  if (!title) return row;
  return {
    ...row,
    load: async (page) =>
      Promise.all(
        (await row.load(page)).map((t) =>
          t.posterPath
            ? t
            : title(t)
                .then((full) =>
                  full
                    ? { ...full, primaryGenreName: t.primaryGenreName ?? full.primaryGenreName }
                    : t,
                )
                .catch(() => t),
        ),
      ),
  };
}

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
            (): Title[] => [],
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

/** What `chip` shows for `type`, a page at a time. */
export function exploreFeed(chip: Chip, type: MediaType, sources: FeedSources): RowDef {
  // Where a chip's titles come from is in its id: a subgenre sits with the recipes but is atlas's.
  if (chip.id.startsWith('genre-')) {
    const genre = Number(chip.id.slice('genre-'.length));
    return discoverRow(sources.pages, `${chip.id}-${type}`, chip.label, {
      mediaType: type,
      genres: [genre],
      primaryGenre: genre,
      voteCountGte: 50,
      releaseDateGte: sources.minYear ? `${sources.minYear}-01-01` : undefined,
    });
  }
  const language = /^lang-([a-z]{2})$/.exec(chip.id)?.[1];
  if (language)
    return discoverRow(sources.pages, `${chip.id}-${type}`, chip.label, {
      mediaType: type,
      originalLanguage: language,
      voteCountGte: 30,
      releaseDateGte: sources.minYear ? `${sources.minYear}-01-01` : undefined,
    });
  // A country or a decade is the browse tail's own row, with its vote floor and the year floor.
  if (chip.id.startsWith('country-') || chip.id.startsWith('decade-')) {
    const row = categories(type, new Date().getFullYear(), { minYear: sources.minYear }).find(
      (category) => category.id === `${chip.id}-${type}`,
    );
    if (row) return discoverRow(sources.pages, row.id, chip.label, row.query);
  }
  if (chip.id.startsWith('recipe-')) {
    const recipe = recipeOf(chip.id.slice('recipe-'.length));
    const query = recipe && retargeted(recipe.query, type);
    if (query) return discoverRow(sources.pages, `${chip.id}-${type}`, chip.label, query);
  } else if ((chip.group === 'mood' || chip.group === 'recipe') && sources.atlas) {
    const row = atlasRows(sources.atlas, type).find((r) => r.id === `atlas-${chip.id}-${type}`);
    if (row) return drawn(row, sources.title);
  }
  return forYou(type, sources);
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
