import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { isHidden, readApiKey, readPrefs } from './prefs';
import { toTitle } from './tmdb';
import type { SettingsRow, Stamp } from './wire';

const at: Stamp = [1000, 0, 'tv01'];
const prefsRow: SettingsRow = {
  kind: 'set',
  schema: 2,
  name: 'prefs',
  values: {
    'den.excludedGenreIDs': { value: { ints: [27] }, at },
    'den.excludedLanguages': { value: { strings: ['hi'] }, at },
    'den.hideAnime': { value: { bool: true }, at },
    'den.hideWatched': { value: { bool: true }, at },
    'den.minReleaseYear': { value: { int: 1990 }, at },
  },
};
const film = (overrides: Partial<Title>): Title => ({
  type: 'movie',
  id: 1,
  title: 'x',
  posterPath: '/p.jpg',
  year: 2020,
  genreIds: [18],
  originalLanguage: 'en',
  ...overrides,
});

describe('prefs', () => {
  it("reads the TV's hide rules, a cleared one as unset, and nothing as the defaults", () => {
    const prefs = readPrefs(prefsRow);
    expect([...prefs.excludedGenres]).toEqual([27]);
    expect([...prefs.excludedLanguages]).toEqual(['hi']);
    expect([prefs.hideAnime, prefs.hideWatched, prefs.minReleaseYear]).toEqual([true, true, 1990]);
    const cleared = { ...prefsRow, values: { 'den.minReleaseYear': { value: null, at } } };
    expect(readPrefs(cleared).minReleaseYear).toBeUndefined();
    expect(readPrefs(undefined)).toEqual({
      excludedGenres: new Set(),
      excludedLanguages: new Set(),
      hideAnime: false,
      hideWatched: false,
      minReleaseYear: undefined,
    });
  });

  it('hides as the TV does, the year floor only outside search', () => {
    const prefs = readPrefs(prefsRow);
    expect(isHidden(film({}), prefs)).toBe(false);
    expect(isHidden(film({ adult: true }), prefs)).toBe(true);
    expect(isHidden(film({ posterPath: undefined }), prefs)).toBe(true);
    expect(isHidden(film({ genreIds: [27, 53] }), prefs)).toBe(true);
    expect(isHidden(film({ originalLanguage: 'hi' }), prefs)).toBe(true);
    expect(isHidden(film({ genreIds: [16], originalLanguage: 'ja' }), prefs)).toBe(true);
    expect(isHidden(film({ genreIds: [16], originalLanguage: 'en' }), prefs), 'Western animation stays').toBe(false);
    expect(isHidden(film({ year: 1985 }), prefs)).toBe(true);
    expect(isHidden(film({ year: 1985 }), prefs, { ignoringYearFloor: true })).toBe(false);
  });

  it('reads an API key the TV shares', () => {
    const keys: SettingsRow = { kind: 'set', schema: 2, name: 'keys', values: { tmdb: { value: { string: 'K1' }, at } } };
    expect(readApiKey(keys, 'tmdb')).toBe('K1');
    expect(readApiKey(keys, 'omdb')).toBeUndefined();
  });

  it('takes genres, language and the adult flag from any TMDB shape', () => {
    const fromSearch = toTitle({ type: 'movie', id: 1 }, { title: 'A', genre_ids: [16, 35], original_language: 'ja' });
    const fromDetail = toTitle({ type: 'tv', id: 2 }, { name: 'B', genres: [{ id: 18, name: 'Drama' }], adult: true });
    expect([fromSearch?.genreIds, fromSearch?.originalLanguage]).toEqual([[16, 35], 'ja']);
    expect([fromDetail?.genreIds, fromDetail?.adult]).toEqual([[18], true]);
  });
});
