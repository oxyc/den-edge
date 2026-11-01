import { expect, it } from 'vitest';
import { libraryMetadataShapeDigest, shapeFromLayoutDigest } from './libraryMetadata';

it('says a series layout in a few bytes, its seasons in order', () => {
  const seasons = [1, 2, 3, 4].map((season) => ({ season, episodes: 10 }));
  expect(libraryMetadataShapeDigest({ seasons: [...seasons].reverse() })).toBe(
    '1:10,2:10,3:10,4:10|',
  );
  expect(libraryMetadataShapeDigest({ seasons, lastAired: { season: 4, episode: 3 } })).toBe(
    '1:10,2:10,3:10,4:10|4:3',
  );
});

it('reads a layout back from what it says', () => {
  expect(shapeFromLayoutDigest('1:13,2:20,3:22,4:7|4:4')).toEqual({
    counts: new Map([
      [1, 13],
      [2, 20],
      [3, 22],
      [4, 7],
    ]),
    lastAired: { season: 4, episode: 4 },
  });
  expect(shapeFromLayoutDigest('0:2,1:8|')).toEqual({
    counts: new Map([
      [0, 2],
      [1, 8],
    ]),
  });
  for (const wrong of ['', '|', '1:8', '1:8,1:9|', 'a:1|'])
    expect(shapeFromLayoutDigest(wrong)).toBe(undefined);
});
