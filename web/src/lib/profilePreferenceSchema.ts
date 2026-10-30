import { RATING_SOURCES, WARNING_GROUPS } from '../settings/catalogs';
import type { ConfigValue, SettingsRow } from './wire';

export const PROFILE_LANGUAGE_LIMIT = 64;
export const PROFILE_GENRE_LIMIT = 128;
export const PROFILE_SERVICE_LIMIT = 256;
export const PROFILE_MIN_YEAR = 1880;
export const PROFILE_MAX_YEAR = 2200;
export const PROFILE_MAX_SUBTITLES_PER_LANGUAGE = 100;

export const PROFILE_RATING_SOURCES = new Set(RATING_SOURCES.map(({ id }) => id));
export const PROFILE_WARNING_CATEGORIES = new Set(
  WARNING_GROUPS.flatMap(({ categories }) => categories),
);

export const isProfileLanguage = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z]{2}$/.test(value);

export const isProfileRegion = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{2}$/.test(value);

export const isProfileYear = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= PROFILE_MIN_YEAR &&
  value <= PROFILE_MAX_YEAR;

export const isProfileSubtitleLimit = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= PROFILE_MAX_SUBTITLES_PER_LANGUAGE;

export const validProfileServices = (values: readonly string[]): boolean =>
  values.length <= PROFILE_SERVICE_LIMIT &&
  values.every((value) => {
    const match = /^(\d+)@([A-Za-z]{2})$/.exec(value);
    const id = Number(match?.[1]);
    return !!match && Number.isSafeInteger(id) && id > 0;
  });

/** The browser boundary equivalent of DenKit.ProfilePreferenceSchema.accepts. */
export function acceptsProfilePreference(key: string, value: ConfigValue | null): boolean {
  if (value === null) return PROFILE_KEYS.has(key);
  switch (key) {
    case 'den.autoSkipSegments':
    case 'den.autoplayTrailers':
    case 'den.hideAnime':
    case 'den.hideWatched':
      return 'bool' in value;
    case 'den.hasExplicitSubtitlePreference':
      return 'bool' in value && value.bool === true;
    case 'den.preferredAudioLanguage':
    case 'den.preferredSubtitleLanguage':
    case 'den.interfaceLanguage':
      return 'string' in value && isProfileLanguage(value.string);
    case 'den.shownSubtitleLanguages':
    case 'den.excludedLanguages':
      return (
        'strings' in value &&
        value.strings.length <= PROFILE_LANGUAGE_LIMIT &&
        value.strings.every(isProfileLanguage)
      );
    case 'den.maxSubtitlesPerLanguage':
      return 'int' in value && isProfileSubtitleLimit(value.int);
    case 'den.excludedGenreIDs':
      return (
        'ints' in value &&
        value.ints.length <= PROFILE_GENRE_LIMIT &&
        value.ints.every((id) => Number.isSafeInteger(id) && id > 0)
      );
    case 'den.minReleaseYear':
      return 'int' in value && isProfileYear(value.int);
    case 'den.enabledRatingSources':
      return (
        'strings' in value &&
        value.strings.length <= PROFILE_RATING_SOURCES.size &&
        value.strings.every((source) => PROFILE_RATING_SOURCES.has(source))
      );
    case 'den.shownWarningCategories':
      return (
        'strings' in value &&
        value.strings.length <= PROFILE_WARNING_CATEGORIES.size &&
        value.strings.every((warning) => PROFILE_WARNING_CATEGORIES.has(warning))
      );
    case 'den.watchRegion':
      return 'string' in value && isProfileRegion(value.string);
    case 'den.myServicePicks':
      return 'strings' in value && validProfileServices(value.strings);
    default:
      return false;
  }
}

/** Keep only profile-owned, canonically typed stamped values before a raw seed crosses a client boundary. */
export function validProfilePreferenceValues(values: SettingsRow['values']): SettingsRow['values'] {
  return Object.fromEntries(
    Object.entries(values).filter(([key, stamped]) => acceptsProfilePreference(key, stamped.value)),
  );
}

const PROFILE_KEYS = new Set([
  'den.autoSkipSegments',
  'den.autoplayTrailers',
  'den.preferredAudioLanguage',
  'den.preferredSubtitleLanguage',
  'den.hasExplicitSubtitlePreference',
  'den.interfaceLanguage',
  'den.shownSubtitleLanguages',
  'den.maxSubtitlesPerLanguage',
  'den.excludedGenreIDs',
  'den.excludedLanguages',
  'den.hideAnime',
  'den.hideWatched',
  'den.minReleaseYear',
  'den.enabledRatingSources',
  'den.shownWarningCategories',
  'den.watchRegion',
  'den.myServicePicks',
]);
