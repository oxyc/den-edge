import { GRANTS_ROW, READ_ROW } from './libraryAssistantAuthority';
import type {
  DevicesView,
  LibrarySelectionValue,
  RatingSource,
  RuntimeDiscoveryView,
  SettingsView,
} from './libraryServiceProtocol';
import { acceptsAddonURL, readPlugins } from './prefs';
import { ADDRESSES, readPrivateAddresses } from './privateAddresses';
import { readDevices, readSyncedPrefs } from '../settings/values';
import type { SettingsRow } from './wire';

const uniqueSorted = <T>(values: Iterable<T>, compare?: (a: T, b: T) => number): T[] =>
  [...new Set(values)].sort(compare);

const isRatingSource = (value: string): value is RatingSource =>
  value === 'imdb' || value === 'tmdb' || value === 'rottenTomatoes' || value === 'metacritic';

const rowsByName = (rows: readonly SettingsRow[]) =>
  new Map(rows.map((row) => [row.name, row] as const));

/** Null means assistant state exists and its policy must be opened by the full authority. */
export function selectedSettingsView(
  rows: readonly SettingsRow[],
  profileAware = false,
): SettingsView | null {
  const byName = rowsByName(rows);
  if (
    Object.keys(byName.get(GRANTS_ROW)?.values ?? {}).length ||
    Object.keys(byName.get(READ_ROW)?.values ?? {}).length
  )
    return null;
  const stored = readSyncedPrefs(profileAware ? undefined : byName.get('prefs'));
  const validLanguage = (value: string | undefined): value is string =>
    value !== undefined && /^[a-z]{2}$/.test(value);
  const services = [
    ...new Map(
      stored.services
        .filter(
          ({ id, country }) => Number.isSafeInteger(id) && id > 0 && /^[A-Z]{2}$/.test(country),
        )
        .map((service) => [`${service.id}@${service.country}`, service] as const),
    ).values(),
  ]
    .sort((a, b) => a.country.localeCompare(b.country) || a.id - b.id)
    .slice(0, 256);
  return {
    kind: 'settings',
    preferences: {
      ...stored,
      excludedGenres: uniqueSorted(
        stored.excludedGenres.filter((id) => Number.isSafeInteger(id) && id > 0),
        (a, b) => a - b,
      ).slice(0, 256),
      excludedLanguages: uniqueSorted(stored.excludedLanguages.filter(validLanguage)).slice(0, 256),
      minReleaseYear:
        stored.minReleaseYear !== undefined &&
        stored.minReleaseYear >= 1800 &&
        stored.minReleaseYear <= 3000
          ? stored.minReleaseYear
          : undefined,
      audioLanguage: validLanguage(stored.audioLanguage) ? stored.audioLanguage : undefined,
      subtitleLanguage: validLanguage(stored.subtitleLanguage)
        ? stored.subtitleLanguage
        : undefined,
      shownSubtitleLanguages: uniqueSorted(
        stored.shownSubtitleLanguages.filter(validLanguage),
      ).slice(0, 256),
      subtitlesPerLanguage:
        Number.isSafeInteger(stored.subtitlesPerLanguage) && stored.subtitlesPerLanguage >= 0
          ? stored.subtitlesPerLanguage
          : 3,
      ratingSources: [...new Set(stored.ratingSources.filter(isRatingSource))],
      shownWarnings: uniqueSorted(
        stored.shownWarnings.filter((warning) => warning.length > 0 && warning.length <= 4_096),
      ).slice(0, 256),
      services,
    },
    assistant: { read: false, write: false },
  };
}

export function selectedDevicesView(rows: readonly SettingsRow[]): DevicesView {
  const devices = rowsByName(rows).get('devices');
  return {
    kind: 'devices',
    devices: readDevices(devices)
      .filter(({ id }) => id.length > 0 && id.length <= 128)
      .slice(0, 512)
      .map(({ id, name, kind, seen, format, play, control, played }) => ({
        id,
        name: name.slice(0, 256),
        kind,
        ...(seen !== undefined && Number.isSafeInteger(seen) && seen >= 0
          ? { lastSeenAt: seen }
          : {}),
        ...(format !== undefined && Number.isSafeInteger(format) && format >= 0
          ? { libraryFormat: format }
          : {}),
        ...(kind === 'tv' && play ? { playKey: play } : {}),
        ...(kind === 'tv' && control !== undefined ? { controlVersion: control } : {}),
        ...(kind === 'tv' && played !== undefined && Number.isSafeInteger(played) && played >= 0
          ? { playedAt: played }
          : {}),
      })),
  };
}

export function selectedRuntimeView(rows: readonly SettingsRow[]): RuntimeDiscoveryView {
  const byName = rowsByName(rows);
  return {
    kind: 'runtime',
    pluginManifestUrls: readPlugins(byName.get('plugins'))
      .filter((url) => url.length <= 4_096 && acceptsAddonURL(url))
      .slice(0, 10_000),
    privateRemuxUrl: readPrivateAddresses(byName.get(ADDRESSES)).remux ?? null,
  };
}

export type SelectedSettingsValue = Extract<
  LibrarySelectionValue,
  { kind: 'settings' | 'devices' | 'runtime' }
>;
