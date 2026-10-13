import { describe, expect, it } from 'vitest';
import type { ProfilePolicy } from './profilePolicy';
import { isolatedProfilePolicy } from './profilePolicy';

describe('isolated profile policy', () => {
  it('inherits household region and services without exposing Owner personal preferences', () => {
    const owner: ProfilePolicy = {
      settings: {
        connection: 'ready',
        value: {
          kind: 'settings',
          assistant: { read: true, write: true },
          preferences: {
            excludedGenres: [27],
            excludedLanguages: ['sv'],
            hideAnime: true,
            hideWatched: true,
            minReleaseYear: 1999,
            audioLanguage: 'sv',
            subtitleLanguage: 'fi',
            shownSubtitleLanguages: ['sv'],
            subtitlesPerLanguage: 1,
            autoSkipSegments: true,
            autoplayTrailers: false,
            ratingSources: [],
            shownWarnings: ['violence'],
            watchRegion: 'FI',
            services: [{ id: 8, country: 'FI' }],
            servicesConfigured: true,
            maturityCeiling: 'r',
          },
        },
      },
    };

    const projected = isolatedProfilePolicy(owner)?.settings.value;

    expect(projected).toMatchObject({
      assistant: { read: false, write: false },
      preferences: {
        excludedGenres: [],
        excludedLanguages: [],
        hideAnime: false,
        hideWatched: false,
        shownSubtitleLanguages: [],
        subtitlesPerLanguage: 3,
        autoSkipSegments: false,
        autoplayTrailers: true,
        ratingSources: ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
        shownWarnings: [],
        watchRegion: 'FI',
        services: [{ id: 8, country: 'FI' }],
        servicesConfigured: true,
      },
    });
    expect(projected?.preferences.audioLanguage).toBeUndefined();
    expect(projected?.preferences.subtitleLanguage).toBeUndefined();
    expect(projected?.preferences.minReleaseYear).toBeUndefined();
    expect(projected?.preferences.maturityCeiling).toBeUndefined();
  });
});
