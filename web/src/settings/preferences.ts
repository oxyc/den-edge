import type {
  LibraryPreferences,
  LibraryPreferencesPatch,
  RatingSource,
  ServiceRef,
} from '../lib/libraryServiceProtocol';
import type { Immutable } from '../lib/libraryModel.svelte';
import type { SubtitlePreference } from '../lib/subtitlePreference';
import { isInterfaceLanguage, type InterfaceLanguage } from '../lib/interfaceLanguage';
import {
  isProfileLanguage,
  isProfileRegion,
  isProfileSubtitleLimit,
  isProfileYear,
  PROFILE_GENRE_LIMIT,
  PROFILE_LANGUAGE_LIMIT,
  PROFILE_MAX_SUBTITLES_PER_LANGUAGE,
  PROFILE_RATING_SOURCES,
  PROFILE_SERVICE_LIMIT,
  PROFILE_WARNING_CATEGORIES,
} from '../lib/profilePreferenceSchema';

export type SettingsPreferences = Immutable<LibraryPreferences>;
export type PreferenceChanges = LibraryPreferencesPatch;

export function effectiveServicePicks(
  prefs: Pick<SettingsPreferences, 'services' | 'servicesConfigured'>,
  defaults: readonly ServiceRef[],
): ServiceRef[] {
  return prefs.servicesConfigured ? [...prefs.services] : [...defaults];
}

export function toggled<T>(values: readonly T[], value: T, on: boolean): T[] {
  const rest = values.filter((candidate) => candidate !== value);
  return on ? [...rest, value] : rest;
}

/** An Ed25519 public key as the TV takes one pasted: 32 bytes of base64, prefix optional. */
export function parsePublicKey(text: string): string | null {
  const body = text.trim().replace(/^ed25519:/i, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    const bytes = atob(body);
    return bytes.length === 32 ? btoa(bytes) : null;
  } catch {
    return null;
  }
}

/** UI-shaped preference edits. The library service owns their storage names and default encoding. */
export const preferenceChange = {
  interfaceLanguage: (interfaceLanguage: InterfaceLanguage): PreferenceChanges => ({
    ...(isInterfaceLanguage(interfaceLanguage) ? { interfaceLanguage } : {}),
  }),
  excludedGenres: (values: Iterable<number>): PreferenceChanges => ({
    excludedGenres: [...new Set([...values].filter((id) => Number.isSafeInteger(id) && id > 0))]
      .sort((a, b) => a - b)
      .slice(0, PROFILE_GENRE_LIMIT),
  }),
  excludedLanguages: (values: Iterable<string>): PreferenceChanges => ({
    excludedLanguages: [...new Set([...values].filter(isProfileLanguage))]
      .sort()
      .slice(0, PROFILE_LANGUAGE_LIMIT),
  }),
  hideAnime: (hideAnime: boolean): PreferenceChanges => ({ hideAnime }),
  hideWatched: (hideWatched: boolean): PreferenceChanges => ({ hideWatched }),
  minReleaseYear: (minReleaseYear: number | undefined): PreferenceChanges => ({
    minReleaseYear: isProfileYear(minReleaseYear) ? minReleaseYear : null,
  }),
  audioLanguage: (audioLanguage: string | undefined): PreferenceChanges => ({
    audioLanguage: isProfileLanguage(audioLanguage) ? audioLanguage : null,
  }),
  subtitlePreference: (subtitlePreference: SubtitlePreference): PreferenceChanges => ({
    subtitlePreference,
  }),
  shownSubtitleLanguages: (values: Iterable<string>): PreferenceChanges => ({
    shownSubtitleLanguages: [...new Set([...values].filter(isProfileLanguage))]
      .sort()
      .slice(0, PROFILE_LANGUAGE_LIMIT),
  }),
  subtitlesPerLanguage: (value: number): PreferenceChanges => ({
    subtitlesPerLanguage: isProfileSubtitleLimit(value)
      ? value
      : Number.isFinite(value)
        ? Math.max(0, Math.min(PROFILE_MAX_SUBTITLES_PER_LANGUAGE, Math.trunc(value)))
        : 3,
  }),
  autoSkipSegments: (autoSkipSegments: boolean): PreferenceChanges => ({ autoSkipSegments }),
  autoplayTrailers: (autoplayTrailers: boolean): PreferenceChanges => ({ autoplayTrailers }),
  ratingSources: (values: Iterable<string>): PreferenceChanges => ({
    ratingSources: {
      kind: 'values',
      values: [
        ...new Set([...values].filter((value) => PROFILE_RATING_SOURCES.has(value))),
      ].sort() as RatingSource[],
    },
  }),
  shownWarnings: (values: Iterable<string>): PreferenceChanges => ({
    shownWarnings: [
      ...new Set([...values].filter((value) => PROFILE_WARNING_CATEGORIES.has(value))),
    ].sort(),
  }),
  watchRegion: (watchRegion: string | undefined): PreferenceChanges => ({
    watchRegion:
      watchRegion && isProfileRegion(watchRegion.toUpperCase()) ? watchRegion.toUpperCase() : null,
  }),
  maturityCeiling: (maturityCeiling: 'pg13' | 'r' | undefined): PreferenceChanges => ({
    maturityCeiling: maturityCeiling ?? null,
  }),
  services: (values: Iterable<ServiceRef>): PreferenceChanges => ({
    services: {
      kind: 'values',
      values: [
        ...new Map(
          [...values]
            .flatMap((value): ServiceRef[] => {
              const country = value.country.toUpperCase();
              return Number.isSafeInteger(value.id) && value.id > 0 && isProfileRegion(country)
                ? [{ id: value.id, country }]
                : [];
            })
            .map((value) => [`${value.id}@${value.country}`, value]),
        ).values(),
      ]
        .sort((a, b) => a.country.localeCompare(b.country) || a.id - b.id)
        .slice(0, PROFILE_SERVICE_LIMIT),
    },
  }),
};
