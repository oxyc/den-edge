// Every preference the TV syncs in `set:prefs` (`UserPreferences.syncedDefaultsTypes`), read with the TV's defaults
// and written the way the TV writes them: arrays sorted so the same choice is the same value on every device, and a
// setting put back to its default cleared rather than stored, as the TV removes the key.

import { RATING_SOURCES } from './catalogs';
import { parseServicePicks, type ServicePick } from '../lib/prefs';
import type { ConfigValue, SettingsRow } from '../lib/wire';
import { readSubtitlePreference, writeSubtitlePreference } from '../lib/subtitlePreference';
import type { SubtitlePreference } from '../lib/subtitlePreference';
import {
  acceptsProfilePreference,
  isProfileLanguage,
  isProfileRegion,
  isProfileSubtitleLimit,
  isProfileYear,
  PROFILE_GENRE_LIMIT,
  PROFILE_LANGUAGE_LIMIT,
  PROFILE_MAX_SUBTITLES_PER_LANGUAGE,
  PROFILE_RATING_SOURCES,
  PROFILE_SERVICE_LIMIT,
  PROFILE_WARNING_CATEGORIES,
} from '../lib/profilePreferenceSchema';

export interface SyncedPrefs {
  excludedGenres: number[];
  excludedLanguages: string[];
  hideAnime: boolean;
  hideWatched: boolean;
  minReleaseYear?: number;
  /** ISO 639-1; undefined is each title's original language. */
  audioLanguage?: string;
  /** ISO 639-1; undefined is off. */
  subtitleLanguage?: string;
  /** False is Automatic; true with no language is explicitly Off. */
  hasExplicitSubtitlePreference: boolean;
  /** Empty shows every language. */
  shownSubtitleLanguages: string[];
  /** 0 keeps every track. */
  subtitlesPerLanguage: number;
  autoSkipSegments: boolean;
  autoplayTrailers: boolean;
  ratingSources: string[];
  /** Empty shows every confirmed warning. */
  shownWarnings: string[];
  /** Uppercase ISO-3166; undefined follows the device. */
  watchRegion?: string;
  services: ServicePick[];
  /** Distinguishes guest defaults from a deliberately saved empty selection. */
  servicesConfigured: boolean;
  /** The parental limit; undefined is none. */
  maturityCeiling?: 'pg13' | 'r';
}

/** A change to `set:prefs`: each key set, or cleared with null. */
export type PrefChanges = Record<string, ConfigValue | null>;

/** The picks a service editor starts from; the first edit copies defaults into the synced preference. */
export function effectiveServicePicks(
  prefs: Pick<SyncedPrefs, 'services' | 'servicesConfigured'>,
  defaults: readonly ServicePick[],
): ServicePick[] {
  return prefs.servicesConfigured ? prefs.services : [...defaults];
}

export function readSyncedPrefs(row: SettingsRow | undefined): SyncedPrefs {
  const rawValue = (key: string): ConfigValue | null => row?.values[key]?.value ?? null;
  const value = (key: string): ConfigValue | null => {
    const held = rawValue(key);
    return acceptsProfilePreference(key, held) ? held : null;
  };
  const strings = (key: string): string[] | undefined => {
    const v = value(key);
    return v && 'strings' in v ? v.strings : undefined;
  };
  const bool = (key: string): boolean | undefined => {
    const v = value(key);
    return v && 'bool' in v ? v.bool : undefined;
  };
  const int = (key: string): number | undefined => {
    const v = value(key);
    return v && 'int' in v ? v.int : undefined;
  };
  const string = (key: string): string | undefined => {
    const v = value(key);
    return v && 'string' in v && v.string ? v.string : undefined;
  };
  const genres = value('den.excludedGenreIDs');
  const region = string('den.watchRegion');
  const rawCeiling = rawValue('den.maturityCeiling');
  const ceiling =
    rawCeiling && 'string' in rawCeiling && rawCeiling.string ? rawCeiling.string : undefined;
  const sources = strings('den.enabledRatingSources');
  const serviceValue = value('den.myServicePicks');
  const subtitle = readSubtitlePreference(row);
  return {
    excludedGenres: genres && 'ints' in genres ? genres.ints : [],
    excludedLanguages: strings('den.excludedLanguages') ?? [],
    hideAnime: bool('den.hideAnime') ?? false,
    hideWatched: bool('den.hideWatched') ?? false,
    minReleaseYear: int('den.minReleaseYear'),
    audioLanguage: string('den.preferredAudioLanguage'),
    subtitleLanguage: subtitle.mode === 'language' ? subtitle.language : undefined,
    hasExplicitSubtitlePreference: subtitle.mode !== 'automatic',
    shownSubtitleLanguages: strings('den.shownSubtitleLanguages') ?? [],
    subtitlesPerLanguage: int('den.maxSubtitlesPerLanguage') ?? 3,
    autoSkipSegments: bool('den.autoSkipSegments') ?? false,
    autoplayTrailers: bool('den.autoplayTrailers') ?? true,
    // Unset is every source; an explicit empty list is every source turned off.
    ratingSources: sources ?? RATING_SOURCES.map((s) => s.id),
    shownWarnings: strings('den.shownWarningCategories') ?? [],
    watchRegion: region,
    services: parseServicePicks(
      serviceValue && 'strings' in serviceValue ? serviceValue.strings : [],
    ),
    servicesConfigured: serviceValue !== null && 'strings' in serviceValue,
    maturityCeiling: ceiling === 'pg13' || ceiling === 'r' ? ceiling : undefined,
  };
}

/** A device holding the library, as it lists itself in `set:devices` under its stamp device id. */
export interface DeviceEntry {
  id: string;
  name: string;
  kind: 'tv' | 'browser';
  /** When it last opened the library (ms); undefined when it never said. */
  seen?: number;
  /** A TV's addons waiting for its approval, by manifest URL. */
  pending: string[];
  /** Library wire understood by the device; absent is a pre-ready build. */
  format?: number;
  /** Tracker providers the device can operate. */
  facade: string[];
  /** Provider/account identities this device still delivers in v2 form. */
  delivers: string[];
  waiting: Record<string, number>;
  connectedAt: Record<string, string>;
  handoff: Record<string, string>;
  /** A TV's household play key, base64url (inbox-v1 §5): any device holding the library plays on it through it. */
  play?: string;
  /** Household transport protocol version; absent means play-only. */
  control?: number;
  /** When a play sent from another device last started on this TV (ms). */
  played?: number;
}

/** Every device in `set:devices` that still names itself, most recently seen first. */
export function readDevices(row: SettingsRow | undefined): DeviceEntry[] {
  const devices = new Map<string, Partial<DeviceEntry>>();
  for (const [name, stamped] of Object.entries(row?.values ?? {})) {
    const match =
      /^([0-9a-z]+)\.(name|kind|seen|pending|format|facade|delivers|play|control|played|waiting:[^:]+|connectedAt:[^:]+|handoff:[^:]+)$/i.exec(
        name,
      );
    const value = stamped.value;
    if (!match || !value) continue;
    const [, id = '', field = ''] = match;
    const device = devices.get(id) ?? { id };
    if (field === 'name' && 'string' in value && value.string.trim()) device.name = value.string;
    if (field === 'kind' && 'string' in value)
      device.kind = value.string === 'tv' ? 'tv' : 'browser';
    if (field === 'seen' && 'int' in value) device.seen = value.int;
    if (field === 'pending' && 'strings' in value) device.pending = value.strings;
    if (field === 'format' && 'int' in value) device.format = value.int;
    if (field === 'facade' && 'strings' in value) device.facade = value.strings;
    if (field === 'delivers' && 'strings' in value) device.delivers = value.strings;
    if (field === 'play' && 'string' in value && /^[A-Za-z0-9_-]{43}$/.test(value.string))
      device.play = value.string;
    if (field === 'control' && 'int' in value && Number.isSafeInteger(value.int) && value.int > 0)
      device.control = value.int;
    if (field === 'played' && 'int' in value) device.played = value.int;
    if (field.startsWith('waiting:') && 'int' in value)
      (device.waiting ??= {})[field.slice('waiting:'.length)] = value.int;
    if (field.startsWith('connectedAt:') && 'string' in value)
      (device.connectedAt ??= {})[field.slice('connectedAt:'.length)] = value.string;
    if (field.startsWith('handoff:') && 'string' in value)
      (device.handoff ??= {})[field.slice('handoff:'.length)] = value.string;
    devices.set(id, device);
  }
  return [...devices.values()]
    .flatMap((d): DeviceEntry[] =>
      d.id
        ? [
            {
              id: d.id,
              name: d.name ?? `Device ${d.id}`,
              kind: d.kind ?? 'browser',
              seen: d.seen,
              pending: d.pending ?? [],
              format: d.format,
              facade: d.facade ?? [],
              delivers: d.delivers ?? [],
              waiting: d.waiting ?? {},
              connectedAt: d.connectedAt ?? {},
              handoff: d.handoff ?? {},
              ...(d.play ? { play: d.play } : {}),
              ...(d.control !== undefined ? { control: d.control } : {}),
              ...(d.played !== undefined ? { played: d.played } : {}),
            },
          ]
        : [],
    )
    .sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0) || a.name.localeCompare(b.name));
}

/** How often a device rewrites its `seen`: once a day is enough to tell a device in use from a forgotten one. */
export const SEEN_EVERY = 24 * 60 * 60 * 1000;

/**
 * This device's own entries, or nothing when what the library already says is recent and right. A TV that takes
 * household plays passes its play key (inbox-v1 §5), published as `<d>.play`.
 */
export function selfEntry(
  row: SettingsRow | undefined,
  self: {
    id: string;
    name: string;
    kind: 'tv' | 'browser';
    play?: string;
    control?: number;
  },
  now: number,
): Record<string, ConfigValue | null> | null {
  const listed = readDevices(row).find((d) => d.id === self.id);
  if (
    listed &&
    listed.name === self.name &&
    listed.kind === self.kind &&
    listed.seen !== undefined &&
    now - listed.seen < SEEN_EVERY &&
    listed.format === 3 &&
    listed.facade.length === 0 &&
    listed.delivers.length === 0 &&
    (self.play === undefined || listed.play === self.play) &&
    (self.control === undefined || listed.control === self.control)
  )
    return null;
  return {
    [`${self.id}.name`]: { string: self.name },
    [`${self.id}.kind`]: { string: self.kind },
    [`${self.id}.seen`]: { int: now },
    [`${self.id}.format`]: { int: 3 },
    [`${self.id}.facade`]: { strings: [] },
    [`${self.id}.delivers`]: { strings: [] },
    ...(self.play !== undefined ? { [`${self.id}.play`]: { string: self.play } } : {}),
    ...(self.control !== undefined ? { [`${self.id}.control`]: { int: self.control } } : {}),
  };
}

/** Takes a device off the list: it lists itself again when it next opens the library. */
export const forgetDevice = (id: string): Record<string, null> =>
  Object.fromEntries(
    [
      'name',
      'kind',
      'seen',
      'pending',
      'format',
      'facade',
      'delivers',
      'play',
      'control',
      'played',
      'connectedAt:simkl',
      'connectedAt:trakt',
      'waiting:simkl',
      'waiting:trakt',
      'handoff:simkl',
      'handoff:trakt',
    ].map((field) => [`${id}.${field}`, null]),
  );

/** The connected media servers in `set:servers`. */
export function readServers(
  row: SettingsRow | undefined,
): { kind: 'jellyfin' | 'plex'; url: string; user?: string }[] {
  const string = (key: string) => {
    const v = row?.values[key]?.value;
    return v && 'string' in v && v.string ? v.string : undefined;
  };
  return (['jellyfin', 'plex'] as const).flatMap((kind) => {
    const url = string(kind);
    return url
      ? [{ kind, url, user: kind === 'jellyfin' ? string('jellyfin.user') : undefined }]
      : [];
  });
}

/** The signing keys pinned in `set:trust`, by manifest URL. */
export function readTrust(row: SettingsRow | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [url, stamped] of Object.entries(row?.values ?? {})) {
    const v = stamped.value;
    if (v && 'string' in v && v.string) keys.set(url, v.string);
  }
  return keys;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * The parental PIN as `set:keys` carries it (den-spec library-v2 §3): `sha256:<salt>:<digest>`, the digest of the salt
 * bytes followed by the PIN, so the PIN itself never sits in the library. Four digits make it slow to read, not
 * impossible to guess.
 */
export async function hashPin(
  pin: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<string> {
  const input = new Uint8Array([...salt, ...new TextEncoder().encode(pin)]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return `sha256:${base64(salt)}:${base64(digest)}`;
}

/** Whether a typed PIN is the stored one: hashed with its salt, or a bare four digits from an older client. */
export async function pinMatches(stored: string, pin: string): Promise<boolean> {
  const [scheme, salt, digest] = stored.split(':');
  if (scheme !== 'sha256' || !salt || !digest) return /^\d{4}$/.test(stored) && stored === pin;
  try {
    return (
      (await hashPin(
        pin,
        Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)),
      )) === stored
    );
  } catch {
    return false;
  }
}

/** An Ed25519 public key as the TV takes one pasted: 32 bytes of base64, with or without an `ed25519:` prefix. */
export function parsePublicKey(text: string): string | null {
  const body = text.trim().replace(/^ed25519:/i, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  try {
    const bytes = atob(body);
    return bytes.length === 32 ? btoa(bytes) : null;
  } catch {
    return null;
  }
}

const sortedStrings = (values: Iterable<string>): ConfigValue => ({
  strings: [...new Set(values)].sort(),
});

const profileLanguages = (values: Iterable<string>): ConfigValue =>
  sortedStrings(
    [...new Set([...values].filter(isProfileLanguage))].slice(0, PROFILE_LANGUAGE_LIMIT),
  );

/** One value in, or out of, a set-valued preference. */
export function toggled<T>(values: readonly T[], value: T, on: boolean): T[] {
  const rest = values.filter((v) => v !== value);
  return on ? [...rest, value] : rest;
}

export const change = {
  excludedGenres: (ids: Iterable<number>): PrefChanges => ({
    'den.excludedGenreIDs': {
      ints: [...new Set([...ids].filter((id) => Number.isSafeInteger(id) && id > 0))]
        .sort((a, b) => a - b)
        .slice(0, PROFILE_GENRE_LIMIT),
    },
  }),
  excludedLanguages: (codes: Iterable<string>): PrefChanges => ({
    'den.excludedLanguages': profileLanguages(codes),
  }),
  hideAnime: (on: boolean): PrefChanges => ({ 'den.hideAnime': { bool: on } }),
  hideWatched: (on: boolean): PrefChanges => ({ 'den.hideWatched': { bool: on } }),
  minReleaseYear: (year: number | undefined): PrefChanges => ({
    'den.minReleaseYear': isProfileYear(year) ? { int: year } : null,
  }),
  audioLanguage: (code: string | undefined): PrefChanges => ({
    'den.preferredAudioLanguage': isProfileLanguage(code) ? { string: code } : null,
  }),
  subtitlePreference: (choice: SubtitlePreference): PrefChanges => writeSubtitlePreference(choice),
  shownSubtitleLanguages: (codes: Iterable<string>): PrefChanges => ({
    'den.shownSubtitleLanguages': profileLanguages(codes),
  }),
  subtitlesPerLanguage: (count: number): PrefChanges => ({
    // An int the TV can decode: a fraction or NaN would fail the whole row there.
    'den.maxSubtitlesPerLanguage': {
      int: isProfileSubtitleLimit(count)
        ? count
        : Number.isFinite(count)
          ? Math.max(0, Math.min(PROFILE_MAX_SUBTITLES_PER_LANGUAGE, Math.trunc(count)))
          : 3,
    },
  }),
  autoSkipSegments: (on: boolean): PrefChanges => ({ 'den.autoSkipSegments': { bool: on } }),
  autoplayTrailers: (on: boolean): PrefChanges => ({ 'den.autoplayTrailers': { bool: on } }),
  ratingSources: (ids: Iterable<string>): PrefChanges => ({
    'den.enabledRatingSources': sortedStrings(
      [...ids].filter((id) => PROFILE_RATING_SOURCES.has(id)),
    ),
  }),
  shownWarnings: (names: Iterable<string>): PrefChanges => ({
    'den.shownWarningCategories': sortedStrings(
      [...names].filter((name) => PROFILE_WARNING_CATEGORIES.has(name)),
    ),
  }),
  watchRegion: (code: string | undefined): PrefChanges => ({
    'den.watchRegion':
      code && isProfileRegion(code.toUpperCase()) ? { string: code.toUpperCase() } : null,
  }),
  maturityCeiling: (ceiling: 'pg13' | 'r' | undefined): PrefChanges => ({
    'den.maturityCeiling': ceiling ? { string: ceiling } : null,
  }),
  // By country, then id as a number (`ServicePick.encode`): sorted as text, 119 would come before 8.
  services: (picks: Iterable<ServicePick>): PrefChanges => ({
    'den.myServicePicks': {
      strings: [
        ...new Set(
          [...picks]
            .flatMap((pick): ServicePick[] => {
              const country = pick.country.toUpperCase();
              return Number.isSafeInteger(pick.id) && pick.id > 0 && isProfileRegion(country)
                ? [{ id: pick.id, country }]
                : [];
            })
            .sort((a, b) => (a.country < b.country ? -1 : a.country > b.country ? 1 : a.id - b.id))
            .map((p) => `${p.id}@${p.country}`),
        ),
      ].slice(0, PROFILE_SERVICE_LIMIT),
    },
  }),
};
