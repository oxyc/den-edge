// A title's and a person's pages from TMDB, as the TV's Detail and Person screens load them: one detail fetch each
// (credits and recommendations appended), and a season's episodes on demand. The parsers are pure, so the tests feed
// them TMDB's own shapes.

import type { MediaType, Title } from './library';
import { strictest } from './parental';
import { toTitle } from './tmdb';

import { tmdbFetch } from './tmdbCache';

const TMDB = 'https://api.themoviedb.org/3';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const list = (v: unknown): Json[] =>
  Array.isArray(v)
    ? v.filter((x): x is Json => !!x && typeof x === 'object' && !Array.isArray(x))
    : [];
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

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
  status?: string;
  lastAirDate?: string;
  lastAired?: { season: number; episode: number };
  certification?: string;
  /**
   * The age certification by country, for the parental ceiling rather than for display: the viewer's region
   * and US, which is what `parental.isBlocked` reads. TMDB's regional entry is often missing where the US one
   * is not, so a ceiling reading only the viewer's country would let an unrated-here title through.
   */
  certifications: Record<string, string>;
  providers: { id: number; name: string; logoPath?: string }[];
  watchLink?: string;
  languages: string[];
  countries: string[];
  studios: string[];
  budget?: number;
  revenue?: number;
  collection?: { id: number; name: string };
  directors: Credit[];
  /** Credited with the screenplay, the writing or the story. */
  writers: Credit[];
  /** A series' creators (`created_by`); empty for a movie. */
  creators: Credit[];
  /** In order, Specials last; a season without episodes is left out. */
  seasons: Season[];
  cast: Credit[];
  /** TMDB's recommendations for it. */
  more: Title[];
  /** Its trailer's YouTube id, from TMDB's videos: what the Trailer link opens. */
  trailer?: string;
  /** Its IMDb id: what den-reel names a title by, so the billboard can ask it for a trailer to play. */
  imdbId?: string;
}

export interface Episode {
  number: number;
  name: string;
  overview?: string;
  stillPath?: string;
  airDate?: string;
  runtime?: number;
}

export interface PersonDetail {
  id: number;
  name: string;
  profilePath?: string;
  biography?: string;
  knownFor?: string;
}

export function parseDetail(
  ref: { type: MediaType; id: number },
  body: Json,
  region = 'US',
): TitleDetail | null {
  const title = toTitle(ref, body);
  if (!title) return null;
  // A series lists its cast across every season; a person with two roles in a movie is listed twice.
  const seen = new Set<number>();
  const cast = list(obj(ref.type === 'tv' ? body.aggregate_credits : body.credits).cast).flatMap(
    (c): Credit[] => {
      const id = num(c.id);
      const name = text(c.name);
      if (id === undefined || !name || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          name,
          role: text(c.character) ?? text(list(c.roles)[0]?.character),
          profilePath: text(c.profile_path),
        },
      ];
    },
  );
  // The crew credited with any of `jobs`, in TMDB's order, once per person and none unnamed.
  const crew = (jobs: readonly string[], role: string) =>
    list(obj(body.credits ?? body.aggregate_credits).crew)
      .flatMap((c): Credit[] => {
        const id = num(c.id),
          name = text(c.name);
        const held = (job: unknown) => jobs.includes(String(job));
        if (id === undefined || !name || (!held(c.job) && !list(c.jobs).some((j) => held(j.job))))
          return [];
        return [{ id, name, role, profilePath: text(c.profile_path) }];
      })
      .filter((c, i, all) => all.findIndex((other) => other.id === c.id) === i);
  const directors = crew(['Director'], 'Director');
  const writers = crew(['Screenplay', 'Writer', 'Story'], 'Writer');
  // A series' `created_by`: usually its only auteur credit, since series-level crew rarely names a director.
  const creators = list(body.created_by)
    .flatMap((c): Credit[] => {
      const id = num(c.id),
        name = text(c.name);
      return id === undefined || !name
        ? []
        : [{ id, name, role: 'Creator', profilePath: text(c.profile_path) }];
    })
    .filter((c, i, all) => all.findIndex((other) => other.id === c.id) === i);
  const providers = obj(obj(obj(body['watch/providers']).results)[region]);
  const certs =
    ref.type === 'tv'
      ? list(obj(body.content_ratings).results)
          .filter((r) => r.iso_3166_1 === region)
          .map((r) => text(r.rating))
      : list(obj(body.release_dates).results)
          .filter((r) => r.iso_3166_1 === region)
          .flatMap((r) =>
            list(r.release_dates)
              .sort((a, b) => Number(b.type === 3) - Number(a.type === 3))
              .map((r) => text(r.certification)),
          );
  // The same ratings by country, for the ceiling rather than for the chip: `parental.isBlocked` reads the
  // stricter of US and the viewer's region, so both are kept even when only one of them is shown.
  const certifications: Record<string, string> = {};
  for (const country of new Set([region.toUpperCase(), 'US'])) {
    const found =
      ref.type === 'tv'
        ? list(obj(body.content_ratings).results)
            .filter((r) => r.iso_3166_1 === country)
            .map((r) => text(r.rating) ?? '')
            .find((rating) => rating !== '')
        : strictest(
            list(obj(body.release_dates).results)
              .filter((r) => r.iso_3166_1 === country)
              .flatMap((r) =>
                list(r.release_dates).map((entry) => text(entry.certification) ?? ''),
              ),
            country,
          );
    if (found) certifications[country] = found;
  }
  const last = obj(body.last_episode_to_air);
  const collection = obj(body.belongs_to_collection);
  const seasons = list(body.seasons)
    .flatMap((s): Season[] => {
      const number = num(s.season_number);
      const episodeCount = num(s.episode_count) ?? 0;
      return number === undefined ||
        !Number.isInteger(number) ||
        number < 0 ||
        !Number.isInteger(episodeCount) ||
        episodeCount <= 0
        ? []
        : [{ number, name: text(s.name) ?? `Season ${number}`, episodeCount }];
    })
    .filter((s, i, all) => all.findIndex((other) => other.number === s.number) === i)
    .sort(
      (a, b) => (a.number === 0 ? Infinity : a.number) - (b.number === 0 ? Infinity : b.number),
    );
  const more = list(obj(body.recommendations).results).flatMap((r) => {
    const id = num(r.id);
    const recommended = id === undefined ? null : toTitle({ type: ref.type, id }, r);
    return recommended ? [recommended] : [];
  });
  const episodeRuns = Array.isArray(body.episode_run_time) ? body.episode_run_time : [];
  const runtime = [num(body.runtime), ...episodeRuns.map(num)].find(
    (m) => m !== undefined && m > 0,
  );
  return {
    title,
    overview: text(body.overview),
    tagline: text(body.tagline),
    backdropPath: text(body.backdrop_path),
    runtime,
    status: text(body.status),
    lastAirDate: text(body.last_air_date),
    lastAired:
      num(last.season_number) !== undefined && num(last.episode_number) !== undefined
        ? { season: Number(last.season_number), episode: Number(last.episode_number) }
        : undefined,
    certification: certs.find(Boolean),
    certifications,
    providers: list(providers.flatrate)
      .flatMap((p) =>
        num(p.provider_id) !== undefined && text(p.provider_name)
          ? [
              {
                id: Number(p.provider_id),
                name: String(p.provider_name),
                logoPath: text(p.logo_path),
              },
            ]
          : [],
      )
      .filter((p, i, all) => all.findIndex((other) => other.id === p.id) === i),
    watchLink: text(providers.link)?.startsWith('https://') ? String(providers.link) : undefined,
    languages: list(body.spoken_languages).flatMap(
      (l) => text(l.english_name) ?? text(l.name) ?? [],
    ),
    countries: list(body.production_countries).flatMap(
      (c) => text(c.name)?.replace('United States of America', 'United States') ?? [],
    ),
    studios: list(ref.type === 'tv' ? body.networks : body.production_companies).flatMap(
      (c) => text(c.name) ?? [],
    ),
    budget: num(body.budget),
    revenue: num(body.revenue),
    collection:
      num(collection.id) !== undefined && text(collection.name)
        ? { id: Number(collection.id), name: String(collection.name) }
        : undefined,
    directors,
    writers,
    creators,
    genres: list(body.genres).flatMap((g) => text(g.name) ?? []),
    seasons,
    cast,
    more: more.filter(
      (t, i, all) => all.findIndex((other) => other.type === t.type && other.id === t.id) === i,
    ),
    trailer: trailerOf(body),
    // A movie carries it at the top level, a series only under external_ids.
    imdbId: text(body.imdb_id) ?? text(obj(body.external_ids).imdb_id),
  };
}

/** A YouTube trailer from TMDB's videos: a trailer before a teaser, an official one before the rest. */
function trailerOf(body: Json): string | undefined {
  const kind = (v: Json) =>
    (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official === true ? 0 : 1);
  const videos = list(obj(body.videos).results).filter(
    (v) => v.site === 'YouTube' && text(v.key) && kind(v) < 4,
  );
  return text(videos.sort((a, b) => kind(a) - kind(b))[0]?.key);
}

export function parseSeason(body: Json): Episode[] {
  const seen = new Set<number>();
  return list(body.episodes).flatMap((e): Episode[] => {
    const number = num(e.episode_number);
    if (number === undefined || !Number.isInteger(number) || number < 1 || seen.has(number))
      return [];
    seen.add(number);
    return [
      {
        number,
        name: text(e.name) ?? `Episode ${number}`,
        overview: text(e.overview),
        stillPath: text(e.still_path),
        airDate: text(e.air_date),
        ...(num(e.runtime) && Number(e.runtime) > 0 ? { runtime: Number(e.runtime) } : {}),
      },
    ];
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
async function tmdb(
  path: string,
  key: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Json | null> {
  const url = new URL(TMDB + path);
  for (const [name, value] of Object.entries({ ...params, api_key: key }))
    url.searchParams.set(name, value);
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
  region = 'US',
): Promise<TitleDetail | null> {
  const append =
    ref.type === 'tv'
      ? 'aggregate_credits,recommendations,videos,external_ids,content_ratings,watch/providers'
      : 'credits,recommendations,videos,external_ids,release_dates,watch/providers';
  const body = await tmdb(`/${ref.type}/${ref.id}`, key, { append_to_response: append }, fetchImpl);
  return body && parseDetail(ref, body, region);
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

export async function fetchPerson(
  id: number,
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<PersonDetail | null> {
  const body = await tmdb(`/person/${id}`, key, {}, fetchImpl);
  return body && parsePerson(id, body);
}

export interface FilmCredit {
  title: Title;
  department: string;
  role?: string;
}

/** Full credits, unlike search's deliberately short notable-films expansion. */
export function parseFilmography(body: Json): FilmCredit[] {
  return [
    ...list(body.cast).map((c): Json => ({ ...c, department: 'Acting' })),
    ...list(body.crew),
  ].flatMap((c): FilmCredit[] => {
    const id = num(c.id);
    if (id === undefined || (c.media_type !== 'movie' && c.media_type !== 'tv')) return [];
    const title = toTitle({ type: c.media_type, id }, c);
    return title
      ? [
          {
            title,
            department: text(c.department) ?? 'Crew',
            role: text(c.character) ?? text(c.job),
          },
        ]
      : [];
  });
}

export function groupFilmography(
  credits: FilmCredit[],
): { department: string; films: FilmCredit[] }[] {
  const priority = ['Acting', 'Directing', 'Production', 'Writing'];
  const departments = [...new Set(credits.map((c) => c.department))];
  departments.sort((a, b) => {
    const rank = (d: string) => (priority.includes(d) ? priority.indexOf(d) : priority.length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return departments.map((department) => {
    const seen = new Set<string>();
    return {
      department,
      films: credits
        .filter((c) => c.department === department)
        .sort(compareFilmCredits)
        .filter((c) => {
          const id = `${c.title.type}:${c.title.id}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
    };
  });
}

const fullDate = (value: string | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;

/** Newest first, including the order within a year; stable provider order is not chronology. */
function compareFilmCredits(a: FilmCredit, b: FilmCredit): number {
  return compareTitleDates(a.title, b.title, -1);
}

/** Chronological title order, with incomplete dates last and deterministic ties. */
function compareTitleDates(a: Title, b: Title, direction: 1 | -1): number {
  const aDate = fullDate(a.releaseDate);
  const bDate = fullDate(b.releaseDate);
  // A year-only or malformed date cannot be placed in an exact chronology. Keep every complete date ahead
  // of that tail even when the incomplete value happens to name a newer year.
  if (Boolean(aDate) !== Boolean(bDate)) return aDate ? -1 : 1;
  if (aDate && bDate && aDate !== bDate) return direction * aDate.localeCompare(bDate);

  if (a.year !== undefined && b.year !== undefined && a.year !== b.year)
    return direction * (a.year - b.year);
  if (a.year !== b.year) return a.year === undefined ? 1 : -1;

  const title = a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  const type = a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  return title || type || a.id - b.id;
}

export async function fetchFilmography(
  id: number,
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<FilmCredit[] | null> {
  const body = await tmdb(`/person/${id}/combined_credits`, key, {}, fetchImpl);
  return body && parseFilmography(body);
}

export async function fetchCollection(
  id: number,
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<Title[]> {
  const body = await tmdb(`/collection/${id}`, key, {}, fetchImpl);
  return list(body?.parts)
    .flatMap((r) => {
      const title =
        num(r.id) === undefined ? null : toTitle({ type: 'movie', id: Number(r.id) }, r);
      return title ? [title] : [];
    })
    .sort((a, b) => compareTitleDates(a, b, 1))
    .filter((t, i, all) => all.findIndex((other) => other.id === t.id) === i);
}
