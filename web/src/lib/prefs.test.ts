import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { acceptsAddonURL, isHidden, readApiKey, readPlugins, readPrefs } from './prefs';
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
    expect(
      isHidden(film({ posterPath: undefined }), prefs, { requirePoster: false }),
      'a surface drawing a backdrop keeps a title that has no poster',
    ).toBe(false);
    expect(
      isHidden(film({ posterPath: undefined, genreIds: [27] }), prefs, { requirePoster: false }),
      'every other rule still applies to it',
    ).toBe(true);
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

  it('lists the addons still wanted, not the removed ones', () => {
    const plugins: SettingsRow = {
      kind: 'set',
      schema: 2,
      name: 'plugins',
      values: {
        'https://b.example/manifest.json': { value: { bool: true }, at },
        'https://gone.example/manifest.json': { value: null, at },
        'http://192.168.1.5:8080/manifest.json': { value: { bool: true }, at },
      },
    };
    expect(readPlugins(plugins)).toEqual(['http://192.168.1.5:8080/manifest.json', 'https://b.example/manifest.json']);
    expect(readPlugins(undefined)).toEqual([]);
  });

  it('takes the addon URLs the TV takes: https, or http on the LAN', () => {
    expect(acceptsAddonURL('https://addon.example/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://192.168.86.193:8080/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://den.local/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://172.20.0.1/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://addon.example/manifest.json')).toBe(false);
    expect(acceptsAddonURL('http://10.0.0.1.attacker.example/manifest.json'), 'a public name ending like an address').toBe(false);
    expect(acceptsAddonURL('http://172.32.0.1/manifest.json')).toBe(false);
    expect(acceptsAddonURL('ftp://addon.example/manifest.json')).toBe(false);
    expect(acceptsAddonURL('not a url')).toBe(false);
  });

  it('takes genres, language and the adult flag from any TMDB shape', () => {
    const fromSearch = toTitle({ type: 'movie', id: 1 }, { title: 'A', genre_ids: [16, 35], original_language: 'ja' });
    const fromDetail = toTitle({ type: 'tv', id: 2 }, { name: 'B', genres: [{ id: 18, name: 'Drama' }], adult: true });
    expect([fromSearch?.genreIds, fromSearch?.originalLanguage]).toEqual([[16, 35], 'ja']);
    expect([fromDetail?.genreIds, fromDetail?.adult]).toEqual([[18], true]);
  });
});
