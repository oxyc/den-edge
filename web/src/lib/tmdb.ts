// Title display from TMDB, for the titles the record log names: rows hold ids and state only. Uses the TMDB key
// the library shares (`set:keys`).

import type { MediaType, Shape, Title } from './library';
import { tmdbFetch } from './tmdbCache';

/** A title's display, and a series' season layout. */
export interface Details {
  title: Title;
  shape?: Shape;
}

export async function fetchDetails(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<Details | null> {
  let details: Record<string, unknown>;
  try {
    // Credits ride along with the display: naming a title is the one fetch made for everything in the library,
    // and who made it is wanted by the billboard's taste. A series bills its cast across seasons.
    const credits = ref.type === 'tv' ? 'aggregate_credits' : 'credits';
    const url = `https://api.themoviedb.org/3/${ref.type}/${ref.id}?api_key=${encodeURIComponent(key)}&append_to_response=${credits}`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    details = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const title = toTitle(ref, details);
  if (!title) return null;
  return ref.type === 'tv' ? { title, shape: seriesShape(details) } : { title };
}

export async function fetchTitle(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<Title | null> {
  return (await fetchDetails(ref, key, fetchImpl))?.title ?? null;
}

/** A title's IMDb id, which scout keys streams by: null when TMDB has none, undefined when TMDB couldn't be asked. */
export async function fetchImdbId(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = tmdbFetch,
): Promise<string | null | undefined> {
  try {
    const res = await fetchImpl(
      `https://api.themoviedb.org/3/${ref.type}/${ref.id}/external_ids?api_key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return undefined;
    const found = ((await res.json()) as { imdb_id?: unknown }).imdb_id;
    return typeof found === 'string' && /^tt\d+$/.test(found) ? found : null;
  } catch {
    return undefined;
  }
}

/** Episodes per season and the newest aired episode, from a series' TMDB details. */
export function seriesShape(details: Record<string, unknown>): Shape | undefined {
  if (!Array.isArray(details.seasons)) return undefined;
  const counts = new Map<number, number>();
  for (const season of details.seasons as { season_number?: unknown; episode_count?: unknown }[]) {
    if (typeof season?.season_number === 'number' && typeof season.episode_count === 'number') {
      counts.set(season.season_number, season.episode_count);
    }
  }
  const last = details.last_episode_to_air as { season_number?: unknown; episode_number?: unknown } | null | undefined;
  const lastAired =
    typeof last?.season_number === 'number' && typeof last.episode_number === 'number'
      ? { season: last.season_number, episode: last.episode_number }
      : undefined;
  return { counts, lastAired };
}

/** A TMDB movie or series object (detail, search result or credit) as a title; null without a name. */
export function toTitle(ref: { type: MediaType; id: number }, details: Record<string, unknown>): Title | null {
  const text = (field: string) => (typeof details[field] === 'string' ? (details[field] as string) : undefined);
  const name = text('title') ?? text('name');
  if (!name) return null;
  const released = text('release_date') ?? text('first_air_date');
  const year = parseInt((released ?? '').slice(0, 4), 10);
  // A list or search result names genres by id; a detail lists them as objects.
  const genreIds = Array.isArray(details.genre_ids)
    ? details.genre_ids.filter((g): g is number => typeof g === 'number')
    : Array.isArray(details.genres)
      ? (details.genres as { id?: unknown }[]).map((g) => g.id).filter((g): g is number => typeof g === 'number')
      : undefined;
  const collection = details.belongs_to_collection as { id?: unknown } | null | undefined;
  // Whoever the title is most identified with: its director, and the head of its billing. More than a few and
  // the profile fills with people nobody chose a film for.
  const credited = (details.credits ?? details.aggregate_credits) as
    | { cast?: unknown; crew?: unknown }
    | null
    | undefined;
  const ids = (value: unknown, take: number, keep: (entry: Record<string, unknown>) => boolean = () => true) =>
    Array.isArray(value)
      ? (value as Record<string, unknown>[])
          .filter((entry) => entry && keep(entry))
          .slice(0, take)
          .flatMap((entry) => (typeof entry.id === 'number' ? [entry.id] : []))
      : [];
  const people = [
    ...ids(credited?.crew, 1, (entry) => entry.job === 'Director'),
    ...ids(credited?.cast, 3),
  ];
  // A film names its production countries; a series names the country it originates in.
  const made = Array.isArray(details.production_countries)
    ? (details.production_countries as { iso_3166_1?: unknown }[]).flatMap((c) =>
        typeof c?.iso_3166_1 === 'string' ? [c.iso_3166_1] : [],
      )
    : Array.isArray(details.origin_country)
      ? details.origin_country.filter((c): c is string => typeof c === 'string')
      : [];
  return {
    type: ref.type,
    id: ref.id,
    title: name,
    collectionId: typeof collection?.id === 'number' ? collection.id : undefined,
    posterPath: text('poster_path'),
    year: Number.isFinite(year) ? year : undefined,
    releaseDate: released,
    rating: typeof details.vote_average === 'number' ? details.vote_average : undefined,
    votes: typeof details.vote_count === 'number' ? details.vote_count : undefined,
    popularity: typeof details.popularity === 'number' ? details.popularity : undefined,
    genreIds,
    originalLanguage: text('original_language'),
    countries: made.length ? made : undefined,
    people: people.length ? people : undefined,
    adult: details.adult === true ? true : undefined,
  };
}
