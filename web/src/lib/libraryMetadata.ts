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

export const libraryMetadataShapeDigest = (shape: LibraryMetadataShape): string =>
  JSON.stringify({
    seasons: [...shape.seasons].sort((left, right) => left.season - right.season),
    lastAired: shape.lastAired ?? null,
  });
