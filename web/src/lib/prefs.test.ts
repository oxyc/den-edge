import { describe, expect, it } from 'vitest';
import type { Title } from './library';
import { isBlocked } from './parental';
import { acceptsAddonURL, isHidden, readApiKey, readPlugins, readPrefs, type Prefs } from './prefs';
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
    // The same provider in two countries is two picks; the rest is what a malformed one looks like.
    'den.myServicePicks': {
      value: { strings: ['8@FI', '8@US', '1899@fi', 'nonsense', '0@FI', '8@FIN'] },
      at,
    },
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
    // Uppercased, and anything that isn't "<id>@<CC>" is dropped rather than guessed at.
    expect(prefs.services).toEqual([
      { id: 8, country: 'FI' },
      { id: 8, country: 'US' },
      { id: 1899, country: 'FI' },
    ]);
    expect(prefs.servicesConfigured).toBe(true);
    const cleared = { ...prefsRow, values: { 'den.minReleaseYear': { value: null, at } } };
    expect(readPrefs(cleared).minReleaseYear).toBeUndefined();
    expect(readPrefs(undefined)).toEqual({
      excludedGenres: new Set(),
      excludedLanguages: new Set(),
      hideAnime: false,
      hideWatched: false,
      minReleaseYear: undefined,
      services: [],
      servicesConfigured: false,
    });
  });

  it('keeps an explicit empty service list distinct from an unset guest list', () => {
    const empty = readPrefs({
      kind: 'set',
      schema: 2,
      name: 'prefs',
      values: { 'den.myServicePicks': { value: { strings: [] }, at } },
    });
    expect(empty.services).toEqual([]);
    expect(empty.servicesConfigured).toBe(true);
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
    expect(
      isHidden(film({ posterPath: undefined, posterUrl: 'https://example/poster.jpg' }), prefs),
      'art a service chart carries is a poster: the card draws it',
    ).toBe(false);
    expect(isHidden(film({ genreIds: [27, 53] }), prefs)).toBe(true);
    expect(isHidden(film({ originalLanguage: 'hi' }), prefs)).toBe(true);
    expect(isHidden(film({ genreIds: [16], originalLanguage: 'ja' }), prefs)).toBe(true);
    expect(
      isHidden(film({ genreIds: [16], originalLanguage: 'en' }), prefs),
      'Western animation stays',
    ).toBe(false);
    expect(isHidden(film({ year: 1985 }), prefs)).toBe(true);
    expect(isHidden(film({ year: 1985 }), prefs, { ignoringYearFloor: true })).toBe(false);
  });

  it('shows a title the typed query names exactly, past the household’s hidden languages and genres', () => {
    // Fauda-shaped: an Arabic-language series the household has hidden by language, as in oxyc/den-edge's
    // example — searching its name is an explicit request, unlike browsing, so it must still be findable.
    const fauda: Title = {
      type: 'tv',
      id: 50,
      title: 'Fauda',
      posterPath: '/p.jpg',
      year: 2015,
      genreIds: [18],
      originalLanguage: 'ar',
    };
    const arabicHidden: Prefs = {
      excludedGenres: new Set(),
      excludedLanguages: new Set(['ar']),
      hideAnime: false,
      hideWatched: false,
      minReleaseYear: undefined,
      services: [],
      servicesConfigured: false,
    };
    expect(
      isHidden(fauda, arabicHidden, { ignoringYearFloor: true, query: 'fauda' }),
      'an exact name match bypasses the hidden-language filter',
    ).toBe(false);
    expect(
      isHidden(fauda, arabicHidden, { ignoringYearFloor: true, query: 'fau' }),
      'three letters is still a guess, not a name typed in full — the filter still applies',
    ).toBe(true);
    const homeland: Title = { ...fauda, id: 51, title: 'Homeland' };
    expect(
      isHidden(homeland, arabicHidden, { ignoringYearFloor: true, query: 'fauda' }),
      'a hit the query does not name keeps today’s filtering exactly',
    ).toBe(true);
    // The bypass only reaches the three filters above; the household's parental ceiling lives outside
    // `isHidden` entirely (enforced at Play, `playGuard.ts`) and this change must never read it.
    expect(
      isHidden(fauda, arabicHidden, { ignoringYearFloor: true, query: 'fauda' }),
      'the direct match is shown in the list',
    ).toBe(false);
    expect(
      isBlocked({ US: 'TV-MA' }, 'US', 'pg13'),
      'but the ceiling still blocks it at Play, untouched by the match above',
    ).toBe(true);
  });

  it('reads an API key the TV shares', () => {
    const keys: SettingsRow = {
      kind: 'set',
      schema: 2,
      name: 'keys',
      values: { tmdb: { value: { string: 'K1' }, at } },
    };
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
    expect(readPlugins(plugins)).toEqual([
      'http://192.168.1.5:8080/manifest.json',
      'https://b.example/manifest.json',
    ]);
    expect(readPlugins(undefined)).toEqual([]);
  });

  it('takes the addon URLs the TV takes: https, or http on the LAN', () => {
    expect(acceptsAddonURL('https://addon.example/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://192.168.86.193:8080/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://den.local/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://172.20.0.1/manifest.json')).toBe(true);
    expect(acceptsAddonURL('http://addon.example/manifest.json')).toBe(false);
    expect(
      acceptsAddonURL('http://10.0.0.1.attacker.example/manifest.json'),
      'a public name ending like an address',
    ).toBe(false);
    expect(acceptsAddonURL('http://172.32.0.1/manifest.json')).toBe(false);
    expect(acceptsAddonURL('ftp://addon.example/manifest.json')).toBe(false);
    expect(acceptsAddonURL('not a url')).toBe(false);
  });

  it('takes genres, language and the adult flag from any TMDB shape', () => {
    const fromSearch = toTitle(
      { type: 'movie', id: 1 },
      { title: 'A', genre_ids: [16, 35], original_language: 'ja' },
    );
    const fromDetail = toTitle(
      { type: 'tv', id: 2 },
      { name: 'B', genres: [{ id: 18, name: 'Drama' }], adult: true },
    );
    expect([fromSearch?.genreIds, fromSearch?.originalLanguage]).toEqual([[16, 35], 'ja']);
    expect([fromDetail?.genreIds, fromDetail?.adult]).toEqual([[18], true]);
  });
});
