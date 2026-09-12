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

/** The user's addons (`set:plugins`): each manifest URL still wanted, sorted. */
export function readPlugins(row: SettingsRow | undefined): string[] {
  return Object.entries(row?.values ?? {})
    .filter(([, stamped]) => stamped.value !== null && 'bool' in stamped.value && stamped.value.bool)
    .map(([url]) => url)
    .sort();
}

/**
 * Whether the TV takes this addon URL (DenKit `AddonClient.acceptsAddonURL`): https anywhere, or http only to a
 * LAN host — localhost, `*.local`, or an RFC 1918 address — so a public addon is never reached in plaintext.
 */
export function acceptsAddonURL(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && lanHost(parsed.hostname);
}

/** An http or https URL to a LAN host: an addon on the homelab, not a public one. */
export function isLanURL(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && lanHost(parsed.hostname);
}

/** localhost, `*.local`, or an RFC 1918 address. */
function lanHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')) return true;
  const labels = host.split('.');
  if (labels.length !== 4 || !labels.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255)) return false;
  const [a = -1, b = -1] = labels.map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Whether the TV would hide this title. Adult titles and titles with no poster never show; the year floor applies
 * unless `ignoringYearFloor` — explicit search sets it, since a title typed by name must be findable — and then the
 * hidden genres and languages, and anime when that's hidden. A surface that draws something other than a poster
 * passes `requirePoster: false`.
 */
export function isHidden(title: Title, prefs: Prefs, { ignoringYearFloor = false, requirePoster = true } = {}): boolean {
  if (title.adult) return true;
  // A card with no poster is a blank card. The billboard draws a backdrop instead, and an addon catalog names
  // titles by id with the artwork left to TMDB — asking for a poster there hides every one of them.
  if (requirePoster && !title.posterPath) return true;
  if (!ignoringYearFloor && prefs.minReleaseYear !== undefined && title.year !== undefined && title.year < prefs.minReleaseYear) {
    return true;
  }
  const genres = title.genreIds ?? [];
  if (genres.some((g) => prefs.excludedGenres.has(g))) return true;
  if (title.originalLanguage && prefs.excludedLanguages.has(title.originalLanguage)) return true;
  return prefs.hideAnime && genres.includes(ANIMATION) && title.originalLanguage === 'ja';
}
