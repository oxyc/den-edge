import { describe, expect, it } from 'vitest';
import { acceptsProfilePreference } from './profilePreferenceSchema';

describe('profile preference schema', () => {
  it('matches the shared scalar bounds and code casing', () => {
    expect(acceptsProfilePreference('den.maxSubtitlesPerLanguage', { int: 100 })).toBe(true);
    expect(acceptsProfilePreference('den.maxSubtitlesPerLanguage', { int: 101 })).toBe(false);
    expect(acceptsProfilePreference('den.minReleaseYear', { int: 1880 })).toBe(true);
    expect(acceptsProfilePreference('den.minReleaseYear', { int: 2200 })).toBe(true);
    expect(acceptsProfilePreference('den.minReleaseYear', { int: 1879 })).toBe(false);
    expect(acceptsProfilePreference('den.preferredAudioLanguage', { string: 'en' })).toBe(true);
    expect(acceptsProfilePreference('den.preferredAudioLanguage', { string: 'EN' })).toBe(false);
    expect(acceptsProfilePreference('den.watchRegion', { string: 'US' })).toBe(true);
    expect(acceptsProfilePreference('den.watchRegion', { string: 'us' })).toBe(false);
    expect(acceptsProfilePreference('den.hasExplicitSubtitlePreference', { bool: true })).toBe(
      true,
    );
    expect(acceptsProfilePreference('den.hasExplicitSubtitlePreference', { bool: false })).toBe(
      false,
    );
  });

  it('rejects an entire malformed bounded collection', () => {
    expect(acceptsProfilePreference('den.enabledRatingSources', { strings: ['imdb'] })).toBe(true);
    expect(
      acceptsProfilePreference('den.enabledRatingSources', { strings: ['imdb', 'unknown'] }),
    ).toBe(false);
    expect(acceptsProfilePreference('den.shownWarningCategories', { strings: ['Spoiler'] })).toBe(
      true,
    );
    expect(
      acceptsProfilePreference('den.shownWarningCategories', { strings: ['Not a category'] }),
    ).toBe(false);
    expect(acceptsProfilePreference('den.myServicePicks', { strings: ['8@FI', '9@us'] })).toBe(
      true,
    );
    expect(acceptsProfilePreference('den.myServicePicks', { strings: ['8@FI@extra'] })).toBe(false);
    expect(acceptsProfilePreference('den.unknown', { bool: true })).toBe(false);
  });
});
