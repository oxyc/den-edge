import type { InterfaceLanguage } from './interfaceLanguage';

/** Locale-neutral presentation copy published by Atlas. Localized output is never put on the wire or cached. */
export interface AtlasHeading {
  id: string;
  args: Readonly<Record<string, string>>;
  fallback: string;
}

const MAX_ID = 128;
const MAX_ARGUMENTS = 12;
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
  if (!object(value)) return undefined;
  const { id, fallback } = value;
  // `arguments` was briefly published by the first rollout worktree. Read it during the transition; all newly
  // forwarded contracts use den-spec's canonical `args` spelling.
  const rawArguments = value.args ?? value.arguments;
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > MAX_ID ||
    typeof fallback !== 'string' ||
    !fallback ||
    fallback.length > MAX_FALLBACK ||
    !object(rawArguments)
  )
    return undefined;
  const entries = Object.entries(rawArguments);
  if (
    entries.length > MAX_ARGUMENTS ||
    entries.some(
      ([name, argument]) =>
        !name ||
        name.length > MAX_ARGUMENT_NAME ||
        typeof argument !== 'string' ||
        argument.length > MAX_ARGUMENT_VALUE,
    )
  )
    return undefined;
  return { id, args: Object.fromEntries(entries) as Record<string, string>, fallback };
}

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
  const argument = heading.args;
  let localized: string | undefined;
  switch (heading.id) {
    case 'atlas.catalog.trending_everywhere':
      localized = language === 'es' ? 'Tendencias en todas partes' : 'Trendigt överallt';
      break;
    case 'atlas.catalog.popular_on':
      if (argument.service)
        localized = `${language === 'es' ? 'Popular en' : 'Populärt på'} ${argument.service}`;
      break;
    case 'atlas.catalog.new_on':
      if (argument.service)
        localized = `${language === 'es' ? 'Novedades en' : 'Nytt på'} ${argument.service}`;
      break;
    case 'atlas.catalog.leaving_soon':
      if (argument.service)
        localized =
          language === 'es'
            ? `Deja ${argument.service} pronto`
            : `Lämnar ${argument.service} snart`;
      break;
    case 'atlas.catalog.coming_to':
      if (argument.service)
        localized = `${language === 'es' ? 'Próximamente en' : 'Kommer till'} ${argument.service}`;
      break;
    case 'atlas.catalog.titles':
      localized = language === 'es' ? 'Títulos' : 'Titlar';
      break;
    case 'recommendation.because_watched':
      return argument.title
        ? language === 'es'
          ? `Porque viste ${argument.title}`
          : `Eftersom du tittade på ${argument.title}`
        : compatibilityFallback;
    case 'recommendation.because_watchlisted':
      return argument.title
        ? language === 'es'
          ? `Porque añadiste ${argument.title} a Mi lista`
          : `Eftersom du lade till ${argument.title} i Min lista`
        : compatibilityFallback;
    case 'person.more_from':
    case 'person.starring': {
      if (!argument.name) return compatibilityFallback;
      const lead =
        heading.id === 'person.starring'
          ? language === 'es'
            ? 'Con'
            : 'Med'
          : language === 'es'
            ? 'Más de'
            : 'Mer från';
      if (!argument.watched_title) return `${lead} ${argument.name}`;
      const because = language === 'es' ? 'porque viste' : 'eftersom du tittade på';
      return `${lead} ${argument.name} — ${because} ${argument.watched_title}`;
    }
    case 'person.created_by':
      return argument.name
        ? `${language === 'es' ? 'Creado por' : 'Skapad av'} ${argument.name}`
        : compatibilityFallback;
    case 'person.written_by':
      return argument.name
        ? `${language === 'es' ? 'Escrito por' : 'Skriven av'} ${argument.name}`
        : compatibilityFallback;
    case 'external.with_media_type':
      return (
        withMediaType(argument.label || heading.fallback, argument.media_type, language) ??
        compatibilityFallback
      );
    case 'category.genre':
    case 'category.recipe':
      return argument.label
        ? (withMediaType(phrase(argument.label), argument.media_type, language) ??
            compatibilityFallback)
        : compatibilityFallback;
    case 'category.decade': {
      const decade = argument.value || argument.label;
      const media = mediaType(argument.media_type, language);
      if (!decade || !media) return compatibilityFallback;
      return language === 'es' ? `${media} de los años ${decade}` : `${media} från ${decade}-talet`;
    }
    case 'category.country': {
      const media = mediaType(argument.media_type, language);
      if (!argument.value || !media) return compatibilityFallback;
      const country = countryName(argument.value, language);
      return language === 'es' ? `${media} de ${country}` : `${media} från ${country}`;
    }
    case 'category.taxonomy':
    case 'category.plot':
    case 'category.acclaimed':
      return argument.label ? phrase(argument.label) : compatibilityFallback;
    case 'verbatim':
      return heading.fallback;
    default:
      return compatibilityFallback;
  }
  return localized
    ? shelfWithMediaType(localized, shelfMediaType, language)
    : compatibilityFallback;
}
