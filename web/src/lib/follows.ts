// Follows and the updates list (den-spec wire/follows-v1.md): the two settings rows, and the events every device
// derives alike from what a profile follows and the public facts it already fetches. Pure: no clock, no fetch.
import { compareStamps, type SettingsRow, type Stamp } from './wire';

export const FOLLOWS_ROW = 'follows';
export const UPDATES_ROW = 'updates';

export type FollowKind = 'tv' | 'movie' | 'person';
export type UpdateMark = 'read' | 'dismissed';
type Values = SettingsRow['values'];

const FOLLOW_KEY = /^(tv|movie|person):([1-9][0-9]{0,15})$/;
const DAY_MS = 86_400_000;
export const EPISODE_DAYS = 7;
export const RETURNS_DAYS = 90;
export const RELEASE_DAYS = 30;
const RETENTION_MS = 180 * DAY_MS;
const UPDATES_LIMIT = 2_000;

export const followKey = (kind: FollowKind, id: number) => `${kind}:${id}`;

const safe = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** §1: the active follows, key → since (Unix ms). */
export function activeFollows(values: Values | undefined): Record<string, number> {
  const active: Record<string, number> = {};
  for (const [key, setting] of Object.entries(values ?? {})) {
    const match = FOLLOW_KEY.exec(key);
    if (!match || !Number.isSafeInteger(Number(match[2]))) continue;
    const value = setting?.value as Record<string, unknown> | null | undefined;
    if (value && Object.keys(value).length === 1 && safe(value.int)) active[key] = value.int;
  }
  return active;
}

const stampOf = (setting: unknown): Stamp | undefined => {
  const at = (setting as { at?: unknown } | null)?.at;
  return Array.isArray(at) &&
    at.length === 3 &&
    safe(at[0]) &&
    safe(at[1]) &&
    typeof at[2] === 'string'
    ? (at as Stamp)
    : undefined;
};

/** §1: event id → read/dismissed, ignoring marks past retention. */
export function updateMarks(values: Values | undefined, now: number): Record<string, UpdateMark> {
  const marks: Record<string, UpdateMark> = {};
  for (const [id, setting] of Object.entries(values ?? {})) {
    const at = stampOf(setting);
    if (!at || at[0] < now - RETENTION_MS) continue;
    const value = setting.value as Record<string, unknown> | null;
    if (
      value &&
      Object.keys(value).length === 1 &&
      (value.string === 'read' || value.string === 'dismissed')
    )
      marks[id] = value.string;
  }
  return marks;
}

/** §1: what a writer keeps of the row's settings before adding its own. */
export function prunedMarks(values: Values, now: number): Values {
  const kept = Object.entries(values).filter(([, setting]) => {
    const at = stampOf(setting);
    return at !== undefined && at[0] >= now - RETENTION_MS;
  });
  kept.sort(([, a], [, b]) => compareStamps(stampOf(b)!, stampOf(a)!));
  return Object.fromEntries(
    kept.slice(0, UPDATES_LIMIT).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** One atlas-dated episode, as `/airing` carries it. */
interface DatedEpisode {
  season: number;
  episode: number;
  date: string;
}

/** The public facts derivation reads, by TMDB id (§3). */
export interface UpdateFacts {
  airing?: Record<
    string,
    {
      source?: string;
      observedAt?: number;
      previous?: DatedEpisode;
      next?: DatedEpisode;
      upcoming?: DatedEpisode[];
      seasonPremiere?: { season: number; date: string };
    }
  >;
  films?: Record<string, { date?: string; observedAt?: number }>;
  credits?: Record<
    string,
    { observedAt?: number; titles: { type: string; id: number; date?: string }[] }
  >;
}

export interface UpdateEvent {
  id: string;
  type: 'episode' | 'returns' | 'release';
  title: { type: 'movie' | 'tv'; id: number };
  season?: number;
  episode?: number;
  date: string;
  precision: 'day';
  source: 'tvmaze' | 'tmdb';
  observedAt: number;
  via: string[];
  read: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A whole calendar day as a day number, or undefined for anything coarser or invalid. */
function dayNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || !DAY.test(value)) return;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const time = Date.UTC(y, m - 1, d);
  const back = new Date(time);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d)
    return;
  return time / DAY_MS;
}

const baselineDay = (since: number) => Math.floor(since / DAY_MS);
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** §3: the profile's events, newest first, with its marks applied. */
export function deriveUpdates(
  today: string,
  follows: Readonly<Record<string, number>>,
  facts: UpdateFacts,
  marks: Readonly<Record<string, UpdateMark>> = {},
): { events: UpdateEvent[]; unread: number } {
  const now = dayNumber(today);
  const found = new Map<string, Omit<UpdateEvent, 'read'>>();
  if (now === undefined) return { events: [], unread: 0 };
  const add = (event: Omit<UpdateEvent, 'via' | 'read' | 'precision'>, via: string) => {
    const held = found.get(event.id);
    if (held) {
      if (!held.via.includes(via)) held.via.push(via);
      return;
    }
    found.set(event.id, { ...event, precision: 'day', via: [via] });
  };
  for (const key of Object.keys(follows).sort(byBytes)) {
    const [kind, raw] = key.split(':') as [FollowKind, string];
    const id = Number(raw);
    const base = baselineDay(follows[key]!);
    if (kind === 'tv') {
      const airing = facts.airing?.[raw];
      if (!airing) continue;
      const source = airing.source === 'tvmaze' ? 'tvmaze' : 'tmdb';
      const observedAt = airing.observedAt ?? 0;
      let newest: { season: number; episode: number; day: number } | undefined;
      for (const one of [airing.previous, airing.next, ...(airing.upcoming ?? [])]) {
        if (!one || !safe(one.season) || !safe(one.episode) || one.season <= 0) continue;
        const day = dayNumber(one.date);
        if (day === undefined || now - day < 0 || now - day > EPISODE_DAYS) continue;
        if (
          !newest ||
          one.season > newest.season ||
          (one.season === newest.season && one.episode > newest.episode)
        )
          newest = { season: one.season, episode: one.episode, day };
      }
      if (newest && newest.day > base)
        add(
          {
            id: `episode:tv:${id}:${newest.season}:${newest.episode}`,
            type: 'episode',
            title: { type: 'tv', id },
            season: newest.season,
            episode: newest.episode,
            date: isoDay(newest.day),
            source,
            observedAt,
          },
          key,
        );
      const premiere = airing.seasonPremiere;
      const day = dayNumber(premiere?.date);
      if (
        premiere &&
        safe(premiere.season) &&
        premiere.season >= 1 &&
        day !== undefined &&
        day - now >= 1 &&
        day - now <= RETURNS_DAYS &&
        day > base
      )
        add(
          {
            id: `returns:tv:${id}:${premiere.season}`,
            type: 'returns',
            title: { type: 'tv', id },
            season: premiere.season,
            date: isoDay(day),
            source,
            observedAt,
          },
          key,
        );
    } else if (kind === 'movie') {
      const film = facts.films?.[raw];
      const day = dayNumber(film?.date);
      if (day !== undefined && now - day >= 0 && now - day <= RELEASE_DAYS && day > base)
        add(
          {
            id: `release:movie:${id}`,
            type: 'release',
            title: { type: 'movie', id },
            date: isoDay(day),
            source: 'tmdb',
            observedAt: film?.observedAt ?? 0,
          },
          key,
        );
    } else {
      const credits = facts.credits?.[raw];
      for (const title of credits?.titles ?? []) {
        if ((title.type !== 'movie' && title.type !== 'tv') || !safe(title.id) || title.id < 1)
          continue;
        if (title.type === 'tv' && follows[`tv:${title.id}`] !== undefined) continue;
        const day = dayNumber(title.date);
        if (day === undefined || now - day < 0 || now - day > RELEASE_DAYS || day <= base) continue;
        add(
          {
            id: `release:${title.type}:${title.id}`,
            type: 'release',
            title: { type: title.type, id: title.id },
            date: isoDay(day),
            source: 'tmdb',
            observedAt: credits?.observedAt ?? 0,
          },
          key,
        );
      }
    }
  }
  const events = [...found.values()]
    .filter((event) => marks[event.id] !== 'dismissed')
    .map((event) => ({
      ...event,
      via: [...event.via].sort(byBytes),
      read: marks[event.id] === 'read',
    }))
    .sort((a, b) => byBytes(b.date, a.date) || byBytes(a.id, b.id));
  return { events, unread: events.filter((event) => !event.read).length };
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
