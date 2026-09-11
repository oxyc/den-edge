// The TV's settings as the web reads them from the record log's settings rows (`set:prefs`, `set:keys`), and the
// TV's hide rules (UserPreferences.isHidden) applied to what the web shows.

import type { Title } from './library';
import type { ConfigValue, SettingsRow } from './wire';

export interface Prefs {
  excludedGenres: Set<number>;
  excludedLanguages: Set<string>;
  hideAnime: boolean;
  hideWatched: boolean;
  /** Titles released before this year stay out of browsing; nil shows every year. */
  minReleaseYear?: number;
}

/** TMDB tags anime and Western cartoons alike as Animation; anime is Animation plus Japanese. */
const ANIMATION = 16;

export function readPrefs(row: SettingsRow | undefined): Prefs {
  const value = (key: string): ConfigValue | null => row?.values[key]?.value ?? null;
  const ints = (key: string) => {
    const v = value(key);
    return v && 'ints' in v ? v.ints : [];
  };
  const strings = (key: string) => {
    const v = value(key);
    return v && 'strings' in v ? v.strings : [];
  };
  const bool = (key: string) => {
    const v = value(key);
    return v !== null && 'bool' in v && v.bool;
  };
  const year = value('den.minReleaseYear');
  return {
    excludedGenres: new Set(ints('den.excludedGenreIDs')),
    excludedLanguages: new Set(strings('den.excludedLanguages')),
    hideAnime: bool('den.hideAnime'),
    hideWatched: bool('den.hideWatched'),
    minReleaseYear: year && 'int' in year ? year.int : undefined,
  };
}

/** One of the user's own API keys (`tmdb`, `omdb`, `doesthedogdie`), as the TV shares it. */
export function readApiKey(row: SettingsRow | undefined, name: string): string | undefined {
  const value = row?.values[name]?.value;
  return value && 'string' in value && value.string ? value.string : undefined;
}

/**
 * Whether the TV would hide this title. Adult titles and titles with no poster never show; the year floor applies
 * unless `ignoringYearFloor` — explicit search sets it, since a title typed by name must be findable — and then the
 * hidden genres and languages, and anime when that's hidden.
 */
export function isHidden(title: Title, prefs: Prefs, { ignoringYearFloor = false } = {}): boolean {
  if (title.adult) return true;
  if (!title.posterPath) return true;
  if (!ignoringYearFloor && prefs.minReleaseYear !== undefined && title.year !== undefined && title.year < prefs.minReleaseYear) {
    return true;
  }
  const genres = title.genreIds ?? [];
  if (genres.some((g) => prefs.excludedGenres.has(g))) return true;
  if (title.originalLanguage && prefs.excludedLanguages.has(title.originalLanguage)) return true;
  return prefs.hideAnime && genres.includes(ANIMATION) && title.originalLanguage === 'ja';
}
