import type {
  LibraryPreferences,
  LibraryPreferencesPatch,
  RatingSource,
  ServiceRef,
} from '../lib/libraryServiceProtocol';
import type { Immutable } from '../lib/libraryModel.svelte';

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
  excludedGenres: (values: Iterable<number>): PreferenceChanges => ({
    excludedGenres: [...new Set(values)].sort((a, b) => a - b),
  }),
  excludedLanguages: (values: Iterable<string>): PreferenceChanges => ({
    excludedLanguages: [...new Set(values)].sort(),
  }),
  hideAnime: (hideAnime: boolean): PreferenceChanges => ({ hideAnime }),
  hideWatched: (hideWatched: boolean): PreferenceChanges => ({ hideWatched }),
  minReleaseYear: (minReleaseYear: number | undefined): PreferenceChanges => ({
    minReleaseYear:
      minReleaseYear === undefined || !Number.isFinite(minReleaseYear)
        ? null
        : Math.trunc(minReleaseYear),
  }),
  audioLanguage: (audioLanguage: string | undefined): PreferenceChanges => ({
    audioLanguage: audioLanguage || null,
  }),
  subtitleLanguage: (subtitleLanguage: string | undefined): PreferenceChanges => ({
    subtitleLanguage: subtitleLanguage || null,
  }),
  shownSubtitleLanguages: (values: Iterable<string>): PreferenceChanges => ({
    shownSubtitleLanguages: [...new Set(values)].sort(),
  }),
  subtitlesPerLanguage: (value: number): PreferenceChanges => ({
    subtitlesPerLanguage: Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 3,
  }),
  autoSkipSegments: (autoSkipSegments: boolean): PreferenceChanges => ({ autoSkipSegments }),
  autoplayTrailers: (autoplayTrailers: boolean): PreferenceChanges => ({ autoplayTrailers }),
  ratingSources: (values: Iterable<string>): PreferenceChanges => ({
    ratingSources: { kind: 'values', values: [...new Set(values)].sort() as RatingSource[] },
  }),
  shownWarnings: (values: Iterable<string>): PreferenceChanges => ({
    shownWarnings: [...new Set(values)].sort(),
  }),
  watchRegion: (watchRegion: string | undefined): PreferenceChanges => ({
    watchRegion: watchRegion ? watchRegion.toUpperCase() : null,
  }),
  maturityCeiling: (maturityCeiling: 'pg13' | 'r' | undefined): PreferenceChanges => ({
    maturityCeiling: maturityCeiling ?? null,
  }),
  services: (values: Iterable<ServiceRef>): PreferenceChanges => ({
    services: {
      kind: 'values',
      values: [
        ...new Map([...values].map((value) => [`${value.id}@${value.country}`, value])).values(),
      ].sort((a, b) => a.country.localeCompare(b.country) || a.id - b.id),
    },
  }),
};
