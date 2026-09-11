// Title display from TMDB, for titles the record log knows but the TV's backup carries no display for: rows hold
// ids and state only. Uses the TMDB key the companion page keeps on this origin (`den.config`).

import type { MediaType, Title } from './library';

export function storedTmdbKey(storage: Storage | undefined = globalThis.localStorage): string {
  try {
    const config = JSON.parse(storage?.getItem('den.config') ?? 'null') as { tmdbKey?: unknown } | null;
    return typeof config?.tmdbKey === 'string' ? config.tmdbKey : '';
  } catch {
    return '';
  }
}

export async function fetchTitle(
  ref: { type: MediaType; id: number },
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Title | null> {
  let details: Record<string, unknown>;
  try {
    const res = await fetchImpl(`https://api.themoviedb.org/3/${ref.type}/${ref.id}?api_key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    details = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  return toTitle(ref, details);
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
