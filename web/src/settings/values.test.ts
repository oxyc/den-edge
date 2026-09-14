import { describe, expect, it } from 'vitest';
import { genreEntries, MOVIE_GENRES, TV_GENRES } from './catalogs';
import {
  change,
  forgetDevice,
  hashPin,
  parsePublicKey,
  pinMatches,
  readDevices,
  readServers,
  readSyncedPrefs,
  readTrust,
  SEEN_EVERY,
  selfEntry,
  toggled,
} from './values';
import type { SettingsRow, Stamp } from '../lib/wire';

const at: Stamp = [1000, 0, 'tv01'];
const row = (values: SettingsRow['values']): SettingsRow => ({
  kind: 'set',
  schema: 2,
  name: 'prefs',
  values,
});

describe('synced prefs', () => {
  it("reads nothing as the TV's defaults", () => {
    expect(readSyncedPrefs(undefined)).toEqual({
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
      watchRegion: undefined,
      services: [],
    });
  });

  it('reads what the TV wrote, an explicit empty rating list as every source off', () => {
    const prefs = readSyncedPrefs(
      row({
        'den.preferredAudioLanguage': { value: { string: 'fi' }, at },
        'den.maxSubtitlesPerLanguage': { value: { int: 0 }, at },
        'den.autoplayTrailers': { value: { bool: false }, at },
        'den.enabledRatingSources': { value: { strings: [] }, at },
        'den.watchRegion': { value: { string: 'se' }, at },
        'den.minReleaseYear': { value: null, at },
      }),
    );
    expect(prefs).toMatchObject({
      audioLanguage: 'fi',
      subtitlesPerLanguage: 0,
      autoplayTrailers: false,
      ratingSources: [],
      watchRegion: 'SE',
      minReleaseYear: undefined,
    });
  });

  it('writes as the TV does: sorted, de-duplicated, and a default cleared', () => {
    expect(change.excludedGenres([878, 27, 27])).toEqual({
      'den.excludedGenreIDs': { ints: [27, 878] },
    });
    expect(change.shownWarnings(['Spoiler', 'Abuse'])).toEqual({
      'den.shownWarningCategories': { strings: ['Abuse', 'Spoiler'] },
    });
    expect(
      change.services([
        { id: 8, country: 'US' },
        { id: 1899, country: 'FI' },
      ]),
    ).toEqual({
      'den.myServicePicks': { strings: ['1899@FI', '8@US'] },
    });
    // In one country by id as a number, as the TV's ServicePick.encode orders them.
    expect(
      change.services([
        { id: 119, country: 'FI' },
        { id: 8, country: 'FI' },
      ]),
    ).toEqual({ 'den.myServicePicks': { strings: ['8@FI', '119@FI'] } });
    expect(change.subtitlesPerLanguage(2.7)).toEqual({ 'den.maxSubtitlesPerLanguage': { int: 2 } });
    expect(change.minReleaseYear(Number.NaN)).toEqual({ 'den.minReleaseYear': null });
    expect(change.watchRegion(undefined)).toEqual({ 'den.watchRegion': null });
    expect(change.minReleaseYear(undefined)).toEqual({ 'den.minReleaseYear': null });
    expect(change.subtitleLanguage(undefined)).toEqual({ 'den.preferredSubtitleLanguage': null });
    expect(toggled(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggled(['b'], 'a', true)).toEqual(['b', 'a']);
  });

  it('reads the parental limit, anything but pg13 or r as none', () => {
    const limit = (value: string) =>
      readSyncedPrefs(row({ 'den.maturityCeiling': { value: { string: value }, at } }))
        .maturityCeiling;
    expect([limit('pg13'), limit('r'), limit('none')]).toEqual(['pg13', 'r', undefined]);
    expect(change.maturityCeiling(undefined)).toEqual({ 'den.maturityCeiling': null });
  });

  it('lists the devices that name themselves, newest first, and lists this one only when stale', () => {
    const devices = row({
      'aaaa000000000001.name': { value: { string: 'Apple TV' }, at },
      'aaaa000000000001.kind': { value: { string: 'tv' }, at },
      'aaaa000000000001.seen': { value: { int: 5000 }, at },
      'bbbb000000000002.name': { value: { string: 'Mac' }, at },
      'bbbb000000000002.seen': { value: { int: 9000 }, at },
      // Taken off the list: its name was cleared.
      'cccc000000000003.name': { value: null, at },
      'cccc000000000003.kind': { value: { string: 'browser' }, at },
    });
    expect(readDevices(devices)).toEqual([
      { id: 'bbbb000000000002', name: 'Mac', kind: 'browser', seen: 9000 },
      { id: 'aaaa000000000001', name: 'Apple TV', kind: 'tv', seen: 5000 },
    ]);
    const self = { id: 'bbbb000000000002', name: 'Mac', kind: 'browser' as const };
    expect(selfEntry(devices, self, 9000 + SEEN_EVERY - 1)).toBeNull();
    expect(selfEntry(devices, { ...self, name: 'MacBook' }, 9001)).toMatchObject({
      'bbbb000000000002.name': { string: 'MacBook' },
    });
    expect(selfEntry(devices, self, 9000 + SEEN_EVERY)).toEqual({
      'bbbb000000000002.name': { string: 'Mac' },
      'bbbb000000000002.kind': { string: 'browser' },
      'bbbb000000000002.seen': { int: 9000 + SEEN_EVERY },
    });
    expect(Object.values(forgetDevice('aaaa000000000001'))).toEqual([null, null, null]);
  });

  it('reads servers and pinned signing keys, and takes a key only when it is one', () => {
    expect(
      readServers(
        row({
          jellyfin: { value: { string: 'https://jelly.local:8096' }, at },
          'jellyfin.user': { value: { string: 'u1' }, at },
          plex: { value: null, at },
        }),
      ),
    ).toEqual([{ kind: 'jellyfin', url: 'https://jelly.local:8096', user: 'u1' }]);
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect([
      ...readTrust(
        row({
          'https://a.example/manifest.json': { value: { string: key }, at },
          'https://b.example/manifest.json': { value: null, at },
        }),
      ),
    ]).toEqual([['https://a.example/manifest.json', key]]);
    expect(parsePublicKey(`ed25519:${key}`)).toBe(key);
    expect(parsePublicKey(btoa('too short'))).toBeNull();
    expect(parsePublicKey('not base64!')).toBeNull();
  });

  it('keeps the PIN as a salted digest, and still takes a bare one from an older client', async () => {
    const stored = await hashPin('1234', new Uint8Array(16).fill(1));
    expect(stored).toMatch(/^sha256:AQEBAQEBAQEBAQEBAQEBAQ==:[A-Za-z0-9+/]{43}=$/);
    expect(stored).not.toContain('1234');
    expect(await pinMatches(stored, '1234')).toBe(true);
    expect(await pinMatches(stored, '4321')).toBe(false);
    // A fresh salt each time, so the same PIN twice doesn't read the same.
    expect(await hashPin('1234')).not.toBe(await hashPin('1234'));
    expect(await pinMatches('1234', '1234')).toBe(true);
    expect(await pinMatches('sha256:not base64!:x', '1234')).toBe(false);
  });

  it('lists genres A–Z with Anime beside Animation, in both lists', () => {
    const movie = genreEntries(MOVIE_GENRES).map((e) => e.name);
    expect(movie.slice(0, 4)).toEqual(['Action', 'Adventure', 'Animation', 'Anime']);
    expect(movie).toHaveLength(20);
    expect(genreEntries(TV_GENRES)).toHaveLength(17);
  });
});
