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

/**
 * A few of atlas's rows (`atlasRows.ts`) as chips: moods say what a genre can't. Named by the row's own id, so a
 * mood both types carry — Feel-Good, Mind-Bending — stays open across a switch. The labels are shorter than the
 * rows' headings, which name the type the toggle beside them already says.
 */
const MOOD_CHIPS: Record<MediaType, [id: string, label: string][]> = {
  movie: [
    ['mood-feel-good', 'Feel-Good'],
    ['mood-mind-bending', 'Mind-Bending'],
    ['mood-twist-ending', 'Twist Endings'],
    ['mood-tearjerker', 'Tearjerkers'],
    ['mood-quirky', 'Quirky'],
    ['mood-cozy', 'Cozy'],
  ],
  tv: [
    ['mood-bingeable', 'Bingeable'],
    ['mood-feel-good', 'Feel-Good'],
    ['mood-mind-bending', 'Mind-Bending'],
    ['mood-dark-gritty', 'Dark & Gritty'],
    ['mood-comfort-watch', 'Comfort Watches'],
    ['mood-tense', 'Edge of Your Seat'],
  ],
};

const recipeOf = (id: string) => RECIPES.find((recipe) => recipe.id === id);

/**
 * The chips for `type`: For You, the genres in the TV's Explore order less the hidden ones, the recipes that have a
 * form for this type, and — where atlas can be reached — its moods.
 */
export function exploreChips(
  type: MediaType,
  { hiddenGenres = new Set<number>(), atlas = false } = {},
): Chip[] {
  const genres = EXPLORE[type]
    .filter((id) => !hiddenGenres.has(id))
    .map((id): Chip => ({ id: `genre-${id}`, label: GENRES[type][id] ?? '', group: 'genre' }));
  const recipes = RECIPE_CHIPS.flatMap((id): Chip[] => {
    const recipe = recipeOf(id);
    return recipe && retargeted(recipe.query, type)
      ? [{ id: `recipe-${id}`, label: recipe.title, group: 'recipe' }]
      : [];
  });
  const moods = atlas
    ? MOOD_CHIPS[type].map(([id, label]): Chip => ({ id, label, group: 'mood' }))
    : [];
  return [{ id: FOR_YOU, label: 'For You', group: 'for-you' }, ...genres, ...recipes, ...moods];
}

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
  if (chip.group === 'genre') {
    const genre = Number(chip.id.slice('genre-'.length));
    return discoverRow(sources.pages, `${chip.id}-${type}`, chip.label, {
      mediaType: type,
      genres: [genre],
      primaryGenre: genre,
      voteCountGte: 50,
      releaseDateGte: sources.minYear ? `${sources.minYear}-01-01` : undefined,
    });
  }
  if (chip.group === 'recipe') {
    const recipe = recipeOf(chip.id.slice('recipe-'.length));
    const query = recipe && retargeted(recipe.query, type);
    if (query) return discoverRow(sources.pages, `${chip.id}-${type}`, chip.label, query);
  }
  if (chip.group === 'mood' && sources.atlas) {
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
