import { expect, it } from 'vitest';
import { libraryMetadataShapeDigest } from './libraryMetadata';

it('says a series layout in a few bytes, its seasons in order', () => {
  const seasons = [1, 2, 3, 4].map((season) => ({ season, episodes: 10 }));
  expect(libraryMetadataShapeDigest({ seasons: [...seasons].reverse() })).toBe(
    '1:10,2:10,3:10,4:10|',
  );
  expect(libraryMetadataShapeDigest({ seasons, lastAired: { season: 4, episode: 3 } })).toBe(
    '1:10,2:10,3:10,4:10|4:3',
  );
});
