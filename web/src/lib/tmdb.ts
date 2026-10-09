// Pure normalization of TMDB-shaped title data. Provider transport and credentials stay in Worker authorities.

import type { MediaType, Shape, Title } from './library';

/** A title's display, and a series' season layout. */
export interface Details {
  title: Title;
  shape?: Shape;
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
  const last = details.last_episode_to_air as
    { season_number?: unknown; episode_number?: unknown } | null | undefined;
  const lastAired =
    typeof last?.season_number === 'number' && typeof last.episode_number === 'number'
      ? { season: last.season_number, episode: last.episode_number }
      : undefined;
  return { counts, lastAired };
}

/** A TMDB movie or series object (detail, search result or credit) as a title; null without a name. */
export function toTitle(
  ref: { type: MediaType; id: number },
  details: Record<string, unknown>,
): Title | null {
  const text = (field: string) =>
    typeof details[field] === 'string' ? (details[field] as string) : undefined;
  const name = text('title') ?? text('name');
  if (!name) return null;
  const released = text('release_date') ?? text('first_air_date');
  const year = parseInt((released ?? '').slice(0, 4), 10);
  // A list or search result names genres by id; a detail lists them as objects.
  const genreIds = Array.isArray(details.genre_ids)
    ? details.genre_ids.filter((g): g is number => typeof g === 'number')
    : Array.isArray(details.genres)
      ? (details.genres as { id?: unknown }[])
          .map((g) => g.id)
          .filter((g): g is number => typeof g === 'number')
      : undefined;
  const collection = details.belongs_to_collection as { id?: unknown } | null | undefined;
  // Whoever the title is most identified with: its director, and the head of its billing. More than a few and
  // the profile fills with people nobody chose a film for.
  const credited = (details.credits ?? details.aggregate_credits) as
    { cast?: unknown; crew?: unknown } | null | undefined;
  const ids = (
    value: unknown,
    take: number,
    keep: (entry: Record<string, unknown>) => boolean = () => true,
  ) =>
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
  // Origin is nationality; production countries include financing/co-production and can be much broader. Older
  // responses without origin_country retain the production-country fallback.
  const origins = Array.isArray(details.origin_country)
    ? details.origin_country.filter((c): c is string => typeof c === 'string')
    : [];
  const made = origins.length
    ? origins
    : Array.isArray(details.production_countries)
      ? (details.production_countries as { iso_3166_1?: unknown }[]).flatMap((c) =>
          typeof c?.iso_3166_1 === 'string' ? [c.iso_3166_1] : [],
        )
      : [];
  const externalIds = details.external_ids as { imdb_id?: unknown } | null | undefined;
  const imdb = typeof details.imdb_id === 'string' ? details.imdb_id : externalIds?.imdb_id;
  return {
    type: ref.type,
    id: ref.id,
    title: name,
    imdbId: typeof imdb === 'string' && /^tt\d+$/.test(imdb) ? imdb : undefined,
    collectionId: typeof collection?.id === 'number' ? collection.id : undefined,
    posterPath: text('poster_path'),
    backdropPath: text('backdrop_path'),
    year: Number.isFinite(year) ? year : undefined,
    releaseDate: released,
    rating: typeof details.vote_average === 'number' ? details.vote_average : undefined,
    ratingSource: typeof details.vote_average === 'number' ? 'tmdb' : undefined,
    votes: typeof details.vote_count === 'number' ? details.vote_count : undefined,
    popularity: typeof details.popularity === 'number' ? details.popularity : undefined,
    genreIds,
    originalLanguage: text('original_language'),
    countries: made.length ? made : undefined,
    people: people.length ? people : undefined,
    adult: details.adult === true ? true : undefined,
  };
}
