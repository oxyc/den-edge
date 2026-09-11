// A title's and a person's pages from TMDB, as the TV's Detail and Person screens load them: one detail fetch each
// (credits and recommendations appended), and a season's episodes on demand. The parsers are pure, so the tests feed
// them TMDB's own shapes.

import type { MediaType, Title } from './library';
import { toTitle } from './tmdb';

import { tmdbFetch } from './tmdbCache';

const TMDB = 'https://api.themoviedb.org/3';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): Json[] =>
  Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface Credit {
  id: number;
  name: string;
  role?: string;
  profilePath?: string;
}

export interface Season {
  number: number;
  name: string;
  episodeCount: number;
}

export interface TitleDetail {
  title: Title;
  overview?: string;
  tagline?: string;
  backdropPath?: string;
  /** Minutes: a movie's runtime, or a series' usual episode. */
  runtime?: number;
  genres: string[];
  /** In order, Specials last; a season without episodes is left out. */
  seasons: Season[];
  cast: Credit[];
  /** TMDB's recommendations for it. */
  more: Title[];
}

export interface Episode {
  number: number;
  name: string;
  overview?: string;
  stillPath?: string;
  airDate?: string;
}

export interface PersonDetail {
  id: number;
  name: string;
  profilePath?: string;
  biography?: string;
  knownFor?: string;
}

/** The top of the bill: a row, not the whole call sheet. */
const CAST_LIMIT = 20;

export function parseDetail(ref: { type: MediaType; id: number }, body: Json): TitleDetail | null {
  const title = toTitle(ref, body);
  if (!title) return null;
  // A series lists its cast across every season; a person with two roles in a movie is listed twice.
  const seen = new Set<number>();
  const cast = list(obj(ref.type === 'tv' ? body.aggregate_credits : body.credits).cast).flatMap((c): Credit[] => {
    const id = num(c.id);
    const name = text(c.name);
    if (id === undefined || !name || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, role: text(c.character) ?? text(list(c.roles)[0]?.character), profilePath: text(c.profile_path) }];
  });
  const seasons = list(body.seasons)
    .flatMap((s): Season[] => {
      const number = num(s.season_number);
      const episodeCount = num(s.episode_count) ?? 0;
      return number === undefined || episodeCount === 0 ? [] : [{ number, name: text(s.name) ?? `Season ${number}`, episodeCount }];
    })
    .sort((a, b) => (a.number === 0 ? Infinity : a.number) - (b.number === 0 ? Infinity : b.number));
  const more = list(obj(body.recommendations).results).flatMap((r) => {
    const id = num(r.id);
    const recommended = id === undefined ? null : toTitle({ type: ref.type, id }, r);
    return recommended ? [recommended] : [];
  });
  const episodeRuns = Array.isArray(body.episode_run_time) ? body.episode_run_time : [];
  const runtime = [num(body.runtime), ...episodeRuns.map(num)].find((m) => m !== undefined && m > 0);
  return {
    title,
    overview: text(body.overview),
    tagline: text(body.tagline),
    backdropPath: text(body.backdrop_path),
    runtime,
    genres: list(body.genres).flatMap((g) => text(g.name) ?? []),
    seasons,
    cast: cast.slice(0, CAST_LIMIT),
    more,
  };
}

export function parseSeason(body: Json): Episode[] {
  return list(body.episodes).flatMap((e): Episode[] => {
    const number = num(e.episode_number);
    if (number === undefined) return [];
    return [{
      number,
      name: text(e.name) ?? `Episode ${number}`,
      overview: text(e.overview),
      stillPath: text(e.still_path),
      airDate: text(e.air_date),
    }];
  });
}

export function parsePerson(id: number, body: Json): PersonDetail | null {
  const name = text(body.name);
  if (!name) return null;
  return {
    id,
    name,
    profilePath: text(body.profile_path),
    biography: text(body.biography),
    knownFor: text(body.known_for_department),
  };
}

/** TMDB's answer, or null when it couldn't give one. */
async function tmdb(path: string, key: string, params: Record<string, string>, fetchImpl: typeof fetch): Promise<Json | null> {
  const url = new URL(TMDB + path);
  for (const [name, value] of Object.entries({ ...params, api_key: key })) url.searchParams.set(name, value);
  try {
    const res = await fetchImpl(url.toString());
    return res.ok ? obj(await res.json()) : null;
  } catch {
    return null;
  }
}

export async function fetchDetail(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<TitleDetail | null> {
  const append = ref.type === 'tv' ? 'aggregate_credits,recommendations' : 'credits,recommendations';
  const body = await tmdb(`/${ref.type}/${ref.id}`, key, { append_to_response: append }, fetchImpl);
  return body && parseDetail(ref, body);
}

/** A season's episodes; null when TMDB couldn't say. */
export async function fetchSeason(
  seriesId: number,
  season: number,
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<Episode[] | null> {
  const body = await tmdb(`/tv/${seriesId}/season/${season}`, key, {}, fetchImpl);
  return body && parseSeason(body);
}

export async function fetchPerson(id: number, key: string, fetchImpl: typeof fetch = tmdbFetch): Promise<PersonDetail | null> {
  const body = await tmdb(`/person/${id}`, key, {}, fetchImpl);
  return body && parsePerson(id, body);
}
