import type { LibraryModel, LibraryModelSnapshot } from './libraryModel.svelte';
import type { LibraryPreferences, SettingsView } from './libraryServiceProtocol';

export interface ProfileContentPolicy {
  readonly maximumAge: number | null;
  readonly unknownRatings: 'allow' | 'block';
}

/** The complete household surface a profile may use while filtering content. */
export interface ProfilePolicy {
  readonly settings: LibraryModelSnapshot<SettingsView>;
}

/**
 * Project the household model onto policy only. The model stays in this closure: consumers cannot reach Owner
 * activity, commands, tracker delivery, or Settings writers through the returned frozen facade.
 */
export function profilePolicy(model: LibraryModel | null): ProfilePolicy | null {
  if (!model) return null;
  return Object.freeze({
    get settings() {
      return model.settings;
    },
  });
}

const isolatedPreferences = (household: {
  readonly watchRegion?: string;
  readonly services: readonly { readonly id: number; readonly country: string }[];
  readonly servicesConfigured: boolean;
}): LibraryPreferences => ({
  excludedGenres: [],
  excludedLanguages: [],
  hideAnime: false,
  hideWatched: false,
  minReleaseYear: undefined,
  audioLanguage: undefined,
  subtitleLanguage: undefined,
  shownSubtitleLanguages: [],
  subtitlesPerLanguage: 3,
  autoSkipSegments: false,
  autoplayTrailers: true,
  ratingSources: ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
  shownWarnings: [],
  watchRegion: household.watchRegion,
  services: [...household.services],
  servicesConfigured: household.servicesConfigured,
  maturityCeiling: undefined,
});

/**
 * Non-Owner sessions may inherit only the two household preferences assigned by profiles-v1 §6. Personal
 * preferences stay at neutral defaults until that profile's own preference store (or Visitor namespace) opens.
 */
export function isolatedProfilePolicy(household: ProfilePolicy | null): ProfilePolicy | null {
  if (!household) return null;
  return Object.freeze({
    get settings(): LibraryModelSnapshot<SettingsView> {
      const source = household.settings;
      // A profile can be constructed while the legacy model seam is still opening; no value is safer than
      // reaching around the projection for Owner settings.
      if (!source) return { connection: 'connecting' };
      const value = source.value;
      return {
        connection: source.connection,
        version: source.version,
        error: source.error,
        value: value
          ? {
              kind: 'settings',
              preferences: isolatedPreferences(value.preferences),
              assistant: { read: false, write: false },
            }
          : undefined,
      };
    },
  });
}
