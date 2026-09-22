// Search before anything is typed: the TV's Explore (SearchModel). A Movies/Series choice, then one chip open at a
// time — For You, a genre, a recipe or one of atlas's moods — and the one endless grid it fills. A chip is named by
// an id that lives in the address (`?c=`), so a view can be linked and Back returns to the chip before it.

import {
  appendUniqueTitles,
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

export type ChipGroup = 'for-you' | 'genre' | 'recipe' | 'mood';

export interface Chip {
  id: string;
  label: string;
  group: ChipGroup;
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
 * genres, the TV's Explore order first, less the hidden ones. Moods and subgenres only where atlas answers.
 */
export function exploreChips(
  type: MediaType,
  { hiddenGenres = new Set<number>(), atlas = false } = {},
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
 * The chips `text` names: a label it begins, then labels with a word it begins, then its synonyms — each once, in
 * that order, For You never. `minWord` leaves out words too short to mean anything, which a filter being typed
 * into wants (1) and a suggestion drawn from a whole query does not (3).
 */
export function matchChips(text: string, chips: Chip[], { minWord = 1 } = {}): Chip[] {
  const phrase = fold(text);
  if (phrase.length < minWord) return [];
  const typed = words(text).filter((word) => word.length >= minWord);
  const offered = chips.filter((chip) => chip.group !== 'for-you');
  const synonyms = new Set(typed.flatMap((word) => SYNONYMS[word] ?? []));
  const found = [
    ...offered.filter((chip) => fold(chip.label).startsWith(phrase)),
    ...offered.filter((chip) =>
      words(chip.label).some((word) => typed.some((t) => word.startsWith(t))),
    ),
    ...offered.filter((chip) => synonyms.has(chip.id)),
  ];
  return [...new Set(found)];
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
  if (chip.id.startsWith('recipe-')) {
    const recipe = recipeOf(chip.id.slice('recipe-'.length));
    const query = recipe && retargeted(recipe.query, type);
    if (query) return discoverRow(sources.pages, `${chip.id}-${type}`, chip.label, query);
  } else if (chip.group !== 'for-you' && sources.atlas) {
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
