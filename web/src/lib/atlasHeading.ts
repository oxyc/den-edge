import type { InterfaceLanguage } from './interfaceLanguage';
import type { ParameterMessageId } from './messages/parameters';

/** Locale-neutral presentation copy published by Atlas. Localized output is never put on the wire or cached. */
export interface AtlasHeading {
  id: string;
  args: Readonly<Record<string, string | number>>;
  fallback: string;
}

const MAX_ID = 128;
const MAX_ARGUMENTS = 16;
const MAX_ARGUMENT_NAME = 64;
const MAX_ARGUMENT_VALUE = 512;
const MAX_FALLBACK = 1_024;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Read Atlas's additive heading contract without making it a condition for accepting an older manifest entry.
 * Bounds keep a compromised upstream from turning a shelf title into unbounded retained UI state.
 */
export function atlasHeadingOf(value: unknown): AtlasHeading | undefined {
  if (typeof value === 'string' && value && Array.from(value).length <= MAX_FALLBACK) {
    return { id: 'den.legacy', args: {}, fallback: value };
  }
  if (!object(value)) return undefined;
  const keys = Object.keys(value);
  const canonical =
    keys.length === 3 && keys.every((key) => key === 'id' || key === 'args' || key === 'fallback');
  const rollout =
    keys.length === 3 &&
    keys.every((key) => key === 'id' || key === 'arguments' || key === 'fallback');
  if (!canonical && !rollout) return undefined;
  const { id, fallback } = value;
  // `arguments` was briefly published by the first rollout worktree. Read it during the transition; all newly
  // forwarded contracts use den-spec's canonical `args` spelling.
  const rawArguments = canonical ? value.args : value.arguments;
  if (
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(id) ||
    id.length > MAX_ID ||
    typeof fallback !== 'string' ||
    !fallback ||
    Array.from(fallback).length > MAX_FALLBACK ||
    !object(rawArguments)
  )
    return undefined;
  const entries = Object.entries(rawArguments);
  if (
    entries.length > MAX_ARGUMENTS ||
    entries.some(
      ([name, argument]) =>
        !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name) ||
        name.length > MAX_ARGUMENT_NAME ||
        !(
          (typeof argument === 'string' && Array.from(argument).length <= MAX_ARGUMENT_VALUE) ||
          (typeof argument === 'number' && Number.isSafeInteger(argument))
        ),
    )
  )
    return undefined;
  return { id, args: Object.fromEntries(entries) as Record<string, string | number>, fallback };
}

const stringArgument = (value: string | number | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

type NonEnglish = Exclude<InterfaceLanguage, 'en'>;

const FIXED: Readonly<Record<string, string>> = {
  'shelf.continue_watching': 'Continue Watching',
  'shelf.watchlist': 'Watchlist',
  'shelf.your_watchlist': 'Your Watchlist',
  'shelf.trending_week': 'Trending This Week',
  'shelf.trending_movies_week': 'Trending Movies This Week',
  'shelf.trending_series_week': 'Trending Series This Week',
  'shelf.new_releases': 'New Releases',
  'shelf.top_rated_movies': 'Top Rated Movies',
  'shelf.top_rated_series': 'Top Rated Series',
  'shelf.upcoming': 'Upcoming',
  'shelf.coming_soon': 'Coming Soon',
  'shelf.you_might_also_like': 'You Might Also Like',
  'shelf.other_versions': 'Other Versions',
  'shelf.more_like_this': 'More Like This',
  'shelf.more_in_this_world': 'More in This World',
};

type Format = (
  id: ParameterMessageId,
  english: string,
  values: Readonly<Record<string, string | number>>,
) => string;

const mediaType = (
  type: string | undefined,
  phrase: (english: string) => string,
): string | undefined =>
  type === 'movie'
    ? phrase('Movies')
    : type === 'tv' || type === 'series'
      ? phrase('Series')
      : undefined;

const withMediaType = (
  label: string,
  type: string | undefined,
  phrase: (english: string) => string,
  format: Format,
) => {
  const media = mediaType(type, phrase);
  return media
    ? format('category.namedType', '{value} {type}', { value: label, type: media })
    : undefined;
};

const shelfWithMediaType = (
  label: string,
  type: 'movie' | 'tv' | undefined,
  phrase: (english: string) => string,
) => {
  const media = mediaType(type, phrase);
  return media ? `${label} · ${media}` : label;
};

const countryName = (code: string, language: NonEnglish): string => {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const headingCase = (value: string, language: NonEnglish): string =>
  value.replace(/^./u, (first) => first.toLocaleUpperCase(language));

/**
 * Format a stable Atlas heading in the selected interface language. English returns the producer's canonical
 * fallback before any registry, Intl or phrase lookup. Unknown future ids do the same in every language.
 */
export function formatAtlasHeading(
  heading: AtlasHeading,
  language: InterfaceLanguage,
  phrase: (english: string) => string,
  format: Format,
  shelfMediaType?: 'movie' | 'tv',
  compatibilityFallback: string = heading.fallback,
): string {
  if (language === 'en') return heading.fallback;
  // Atlas owns the stable id and canonical English fallback; the existing lazy locale catalog owns translated
  // copy. Only registered ids are looked up: unknown future ids must preserve their fallback verbatim.
  const fixed = FIXED[heading.id];
  if (fixed) return shelfWithMediaType(phrase(fixed), shelfMediaType, phrase);
  if (heading.id.startsWith('atlas.taxonomy.'))
    return headingCase(phrase(heading.fallback), language);
  const argument = heading.args;
  const service = stringArgument(argument.service);
  let localized: string | undefined;
  switch (heading.id) {
    case 'atlas.catalog.trending_everywhere':
      localized = phrase(heading.fallback);
      break;
    case 'atlas.catalog.popular_on':
      if (service) localized = format('atlas.popularOn', 'Popular on {service}', { service });
      break;
    case 'atlas.catalog.new_on':
      if (service) localized = format('atlas.newOn', 'New on {service}', { service });
      break;
    case 'atlas.catalog.leaving_soon':
      if (service) localized = format('atlas.leavingSoon', 'Leaving {service} soon', { service });
      break;
    case 'atlas.catalog.coming_to':
      if (service) localized = format('atlas.comingTo', 'Coming to {service}', { service });
      break;
    case 'atlas.catalog.titles':
      localized = phrase(heading.fallback);
      break;
    case 'recommendation.because_watched':
      return stringArgument(argument.title)
        ? format('category.becauseWatched', 'Because you watched {value}', {
            value: stringArgument(argument.title)!,
          })
        : compatibilityFallback;
    case 'recommendation.because_watchlisted':
      return stringArgument(argument.title)
        ? format('category.becauseWatchlisted', 'Because you added {value} to your Watchlist', {
            value: stringArgument(argument.title)!,
          })
        : compatibilityFallback;
    case 'recommendation.because_genre':
      return stringArgument(argument.genre)
        ? format('category.becauseGenre', 'Because you watch {value}', {
            value: phrase(stringArgument(argument.genre)!),
          })
        : compatibilityFallback;
    case 'person.more_from':
    case 'person.starring': {
      const name = stringArgument(argument.name);
      if (!name) return compatibilityFallback;
      const watchedTitle = stringArgument(argument.watched_title);
      if (watchedTitle)
        return heading.id === 'person.starring'
          ? format('person.starringBecause', 'Starring {name} — because you watched {title}', {
              name,
              title: watchedTitle,
            })
          : format('person.moreFromBecause', 'More from {name} — because you watched {title}', {
              name,
              title: watchedTitle,
            });
      return heading.id === 'person.starring'
        ? format('related.starring', 'Starring {value}', { value: name })
        : format('related.moreFrom', 'More from {value}', { value: name });
    }
    case 'person.created_by':
      return stringArgument(argument.name)
        ? format('related.createdBy', 'Created by {value}', {
            value: stringArgument(argument.name)!,
          })
        : compatibilityFallback;
    case 'person.written_by':
      return stringArgument(argument.name)
        ? format('related.writtenBy', 'Written by {value}', {
            value: stringArgument(argument.name)!,
          })
        : compatibilityFallback;
    case 'external.with_media_type':
      return (
        withMediaType(
          stringArgument(argument.label) || heading.fallback,
          stringArgument(argument.media_type),
          phrase,
          format,
        ) ?? compatibilityFallback
      );
    case 'category.genre':
    case 'category.recipe': {
      if (!stringArgument(argument.label)) return compatibilityFallback;
      const categoryLabel = phrase(stringArgument(argument.label)!);
      return argument.names_media_type === 'true'
        ? (withMediaType(categoryLabel, stringArgument(argument.media_type), phrase, format) ??
            compatibilityFallback)
        : headingCase(categoryLabel, language);
    }
    case 'category.decade': {
      const decade = stringArgument(argument.value) || stringArgument(argument.label);
      const media = mediaType(stringArgument(argument.media_type), phrase);
      if (!decade || !media) return compatibilityFallback;
      return format('category.decadeType', '{decade}s {type}', { decade, type: media });
    }
    case 'category.country': {
      const media = mediaType(stringArgument(argument.media_type), phrase);
      if (!argument.value || !media) return compatibilityFallback;
      const country = countryName(String(argument.value), language);
      return format('category.countryType', '{country} {type}', { country, type: media });
    }
    case 'category.taxonomy':
    case 'category.plot':
    case 'category.acclaimed':
      return argument.label
        ? headingCase(phrase(String(argument.label)), language)
        : compatibilityFallback;
    case 'category.service_sort':
      if (!stringArgument(argument.label)) return compatibilityFallback;
      if (argument.names_media_type !== 'true')
        return headingCase(phrase(stringArgument(argument.label)!), language);
      {
        const media = mediaType(stringArgument(argument.media_type), phrase);
        if (!media) return compatibilityFallback;
        return format('category.serviceSort', '{value} {type}', {
          value: headingCase(phrase(stringArgument(argument.label)!), language),
          type: media,
        });
      }
    case 'den.verbatim':
      return heading.fallback;
    default:
      return compatibilityFallback;
  }
  return localized ? shelfWithMediaType(localized, shelfMediaType, phrase) : compatibilityFallback;
}
