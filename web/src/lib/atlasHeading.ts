import type { InterfaceLanguage } from './interfaceLanguage';

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
  const { id, fallback } = value;
  // `arguments` was briefly published by the first rollout worktree. Read it during the transition; all newly
  // forwarded contracts use den-spec's canonical `args` spelling.
  const rawArguments = value.args ?? value.arguments;
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

const FIXED: Readonly<Record<string, Readonly<Record<NonEnglish, string>>>> = {
  'shelf.continue_watching': { es: 'Seguir viendo', sv: 'Fortsätt titta' },
  'shelf.watchlist': { es: 'Mi lista', sv: 'Min lista' },
  'shelf.your_watchlist': { es: 'Tu lista', sv: 'Din lista' },
  'shelf.trending_week': { es: 'Tendencias de esta semana', sv: 'Trendigt den här veckan' },
  'shelf.trending_movies_week': {
    es: 'Películas populares esta semana',
    sv: 'Trendande filmer den här veckan',
  },
  'shelf.trending_series_week': {
    es: 'Series populares esta semana',
    sv: 'Trendande serier den här veckan',
  },
  'shelf.new_releases': { es: 'Nuevos lanzamientos', sv: 'Nya släpp' },
  'shelf.top_rated_movies': { es: 'Películas mejor valoradas', sv: 'Topprankade filmer' },
  'shelf.top_rated_series': { es: 'Series mejor valoradas', sv: 'Topprankade serier' },
  'shelf.upcoming': { es: 'Próximamente', sv: 'Kommande' },
  'shelf.coming_soon': { es: 'Próximamente', sv: 'Kommer snart' },
  'shelf.you_might_also_like': { es: 'También te podría gustar', sv: 'Du kanske också gillar' },
  'shelf.other_versions': { es: 'Otras versiones', sv: 'Andra versioner' },
  'shelf.more_like_this': { es: 'Más como esto', sv: 'Mer som detta' },
  'shelf.more_in_this_world': {
    es: 'Más de este universo',
    sv: 'Mer från den här världen',
  },
};

const mediaType = (type: string | undefined, language: NonEnglish): string | undefined =>
  type === 'movie'
    ? language === 'es'
      ? 'Películas'
      : 'Filmer'
    : type === 'tv' || type === 'series'
      ? language === 'es'
        ? 'Series'
        : 'Serier'
      : undefined;

const withMediaType = (label: string, type: string | undefined, language: NonEnglish) => {
  const media = mediaType(type, language);
  if (!media) return undefined;
  return language === 'es' ? `${media} de ${label}` : `${media}: ${label}`;
};

const shelfWithMediaType = (
  label: string,
  type: 'movie' | 'tv' | undefined,
  language: NonEnglish,
) => {
  const media = mediaType(type, language);
  return media ? `${label} · ${media}` : label;
};

const countryName = (code: string, language: NonEnglish): string => {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/**
 * Format a stable Atlas heading in the selected interface language. English returns the producer's canonical
 * fallback before any registry, Intl or phrase lookup. Unknown future ids do the same in every language.
 */
export function formatAtlasHeading(
  heading: AtlasHeading,
  language: InterfaceLanguage,
  phrase: (english: string) => string = (english) => english,
  shelfMediaType?: 'movie' | 'tv',
  compatibilityFallback: string = heading.fallback,
): string {
  if (language === 'en') return heading.fallback;
  const fixed = FIXED[heading.id]?.[language];
  if (fixed) return shelfWithMediaType(fixed, shelfMediaType, language);
  if (heading.id.startsWith('atlas.taxonomy.')) return phrase(heading.fallback);
  const argument = heading.args;
  const service = stringArgument(argument.service);
  let localized: string | undefined;
  switch (heading.id) {
    case 'atlas.catalog.trending_everywhere':
      localized = language === 'es' ? 'Tendencias en todas partes' : 'Trendigt överallt';
      break;
    case 'atlas.catalog.popular_on':
      if (service) localized = `${language === 'es' ? 'Popular en' : 'Populärt på'} ${service}`;
      break;
    case 'atlas.catalog.new_on':
      if (service) localized = `${language === 'es' ? 'Novedades en' : 'Nytt på'} ${service}`;
      break;
    case 'atlas.catalog.leaving_soon':
      if (service)
        localized = language === 'es' ? `Deja ${service} pronto` : `Lämnar ${service} snart`;
      break;
    case 'atlas.catalog.coming_to':
      if (service)
        localized = `${language === 'es' ? 'Próximamente en' : 'Kommer till'} ${service}`;
      break;
    case 'atlas.catalog.titles':
      localized = language === 'es' ? 'Títulos' : 'Titlar';
      break;
    case 'recommendation.because_watched':
      return stringArgument(argument.title)
        ? language === 'es'
          ? `Porque viste ${stringArgument(argument.title)}`
          : `Eftersom du tittade på ${stringArgument(argument.title)}`
        : compatibilityFallback;
    case 'recommendation.because_watchlisted':
      return stringArgument(argument.title)
        ? language === 'es'
          ? `Porque añadiste ${stringArgument(argument.title)} a Mi lista`
          : `Eftersom du lade till ${stringArgument(argument.title)} i Min lista`
        : compatibilityFallback;
    case 'person.more_from':
    case 'person.starring': {
      const name = stringArgument(argument.name);
      if (!name) return compatibilityFallback;
      const lead =
        heading.id === 'person.starring'
          ? language === 'es'
            ? 'Con'
            : 'Med'
          : language === 'es'
            ? 'Más de'
            : 'Mer från';
      const watchedTitle = stringArgument(argument.watched_title);
      if (!watchedTitle) return `${lead} ${name}`;
      const because = language === 'es' ? 'porque viste' : 'eftersom du tittade på';
      return `${lead} ${name} — ${because} ${watchedTitle}`;
    }
    case 'person.created_by':
      return stringArgument(argument.name)
        ? `${language === 'es' ? 'Creado por' : 'Skapad av'} ${stringArgument(argument.name)}`
        : compatibilityFallback;
    case 'person.written_by':
      return stringArgument(argument.name)
        ? `${language === 'es' ? 'Escrito por' : 'Skriven av'} ${stringArgument(argument.name)}`
        : compatibilityFallback;
    case 'external.with_media_type':
      return (
        withMediaType(
          stringArgument(argument.label) || heading.fallback,
          stringArgument(argument.media_type),
          language,
        ) ?? compatibilityFallback
      );
    case 'category.genre':
    case 'category.recipe': {
      if (!stringArgument(argument.label)) return compatibilityFallback;
      const categoryLabel = phrase(stringArgument(argument.label)!);
      return argument.names_media_type === 'true'
        ? (withMediaType(categoryLabel, stringArgument(argument.media_type), language) ??
            compatibilityFallback)
        : categoryLabel;
    }
    case 'category.decade': {
      const decade = stringArgument(argument.value) || stringArgument(argument.label);
      const media = mediaType(stringArgument(argument.media_type), language);
      if (!decade || !media) return compatibilityFallback;
      return language === 'es' ? `${media} de los años ${decade}` : `${media} från ${decade}-talet`;
    }
    case 'category.country': {
      const media = mediaType(stringArgument(argument.media_type), language);
      if (!argument.value || !media) return compatibilityFallback;
      const country = countryName(String(argument.value), language);
      return language === 'es' ? `${media} de ${country}` : `${media} från ${country}`;
    }
    case 'category.taxonomy':
    case 'category.plot':
    case 'category.acclaimed':
      return argument.label ? phrase(String(argument.label)) : compatibilityFallback;
    case 'den.verbatim':
      return heading.fallback;
    default:
      return compatibilityFallback;
  }
  return localized
    ? shelfWithMediaType(localized, shelfMediaType, language)
    : compatibilityFallback;
}
