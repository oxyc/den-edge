// Title display from TMDB, for the titles the record log names: rows hold ids and state only. Uses the TMDB key
// the library shares (`set:keys`).

import type { MediaType, Shape, Title } from './library';

/** A title's display, and a series' season layout. */
export interface Details {
  title: Title;
  shape?: Shape;
}

export async function fetchDetails(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Details | null> {
  let details: Record<string, unknown>;
  try {
    const res = await fetchImpl(`https://api.themoviedb.org/3/${ref.type}/${ref.id}?api_key=${encodeURIComponent(key)}`);
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
  fetchImpl: typeof fetch = fetch,
): Promise<Title | null> {
  return (await fetchDetails(ref, key, fetchImpl))?.title ?? null;
}

/** A title's IMDb id, which scout keys streams by: null when TMDB has none, undefined when TMDB couldn't be asked. */
export async function fetchImdbId(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = fetch,
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
  const year = parseInt((text('release_date') ?? text('first_air_date') ?? '').slice(0, 4), 10);
  // A list or search result names genres by id; a detail lists them as objects.
  const genreIds = Array.isArray(details.genre_ids)
    ? details.genre_ids.filter((g): g is number => typeof g === 'number')
    : Array.isArray(details.genres)
      ? (details.genres as { id?: unknown }[]).map((g) => g.id).filter((g): g is number => typeof g === 'number')
      : undefined;
  const collection = details.belongs_to_collection as { id?: unknown } | null | undefined;
  return {
    type: ref.type,
    id: ref.id,
    title: name,
    collectionId: typeof collection?.id === 'number' ? collection.id : undefined,
    posterPath: text('poster_path'),
    year: Number.isFinite(year) ? year : undefined,
    rating: typeof details.vote_average === 'number' ? details.vote_average : undefined,
    genreIds,
    originalLanguage: text('original_language'),
    adult: details.adult === true ? true : undefined,
  };
}
