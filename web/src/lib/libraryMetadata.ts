import type { Shape, Title } from './library';
import {
  LIBRARY_SERVICE_WIRE_LIMITS,
  type LibraryMetadataShape,
  type LibraryMetadataTitle,
  type TitleRef,
} from './libraryServiceProtocol';
import { isLibraryMetadataTitle } from './libraryServiceProtocolCodec';

export function libraryMetadataTitle(title: Title): LibraryMetadataTitle | undefined {
  const candidate = { ...title };
  if (!candidate.posterPath) delete candidate.posterPath;
  if (!candidate.backdropPath) delete candidate.backdropPath;
  if (!candidate.releaseDate) delete candidate.releaseDate;
  if (!candidate.originalLanguage) delete candidate.originalLanguage;
  return isLibraryMetadataTitle(candidate) ? candidate : undefined;
}

export function libraryMetadataShape(
  ref: TitleRef,
  shape: Shape,
): LibraryMetadataShape | undefined {
  if (ref.type !== 'tv' || shape.counts.size > LIBRARY_SERVICE_WIRE_LIMITS.shapeSeasons)
    return undefined;
  const seasons = [...shape.counts].map(([season, episodes]) => ({ season, episodes }));
  if (
    seasons.some(
      ({ season, episodes }) =>
        !Number.isSafeInteger(season) ||
        season < 0 ||
        !Number.isSafeInteger(episodes) ||
        episodes < 0,
    )
  )
    return undefined;
  if (shape.lastAired) {
    const episodes = shape.counts.get(shape.lastAired.season);
    if (
      !Number.isSafeInteger(shape.lastAired.season) ||
      shape.lastAired.season <= 0 ||
      !Number.isSafeInteger(shape.lastAired.episode) ||
      shape.lastAired.episode <= 0 ||
      episodes === undefined ||
      shape.lastAired.episode > episodes
    )
      return undefined;
  }
  return {
    title: { type: 'tv', id: ref.id },
    seasons,
    ...(shape.lastAired ? { lastAired: shape.lastAired } : {}),
  };
}

/**
 * A series layout as one short string, `season:episodes,…|season:episode` (its seasons in order, then the last aired
 * episode), compared to tell whether a layout changed. Kept in Continue's saved piece once per series it holds, so it is
 * as small as it can be and still say the whole layout.
 */
export const libraryMetadataShapeDigest = (
  shape: Pick<LibraryMetadataShape, 'seasons' | 'lastAired'>,
): string =>
  `${[...shape.seasons]
    .sort((left, right) => left.season - right.season)
    .map(({ season, episodes }) => `${season}:${episodes}`)
    .join(',')}|${shape.lastAired ? `${shape.lastAired.season}:${shape.lastAired.episode}` : ''}`;

/**
 * The layout a `libraryMetadataShapeDigest` says, read back; undefined for anything that is not one. The saved Continue
 * piece keeps only these, so they are what its series' layouts are known by until the page names them again.
 */
export function shapeFromLayoutDigest(digest: string): Shape | undefined {
  const match = /^((?:\d+:\d+)(?:,\d+:\d+)*)?\|(?:(\d+):(\d+))?$/.exec(digest);
  if (!match) return undefined;
  const counts = new Map<number, number>();
  for (const part of match[1]?.split(',') ?? []) {
    const [season, episodes] = part.split(':').map(Number) as [number, number];
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episodes) || counts.has(season))
      return undefined;
    counts.set(season, episodes);
  }
  if (!counts.size) return undefined;
  return {
    counts,
    ...(match[2] ? { lastAired: { season: Number(match[2]), episode: Number(match[3]) } } : {}),
  };
}
