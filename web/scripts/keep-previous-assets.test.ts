import { describe, expect, it } from 'vitest';
import { chooseCarryForward, hashFiles } from './keep-previous-assets.mjs';

describe('hashFiles', () => {
  it('is the same id for the same set of files, in any order', () => {
    expect(hashFiles(['b.js', 'a.js'])).toBe(hashFiles(['a.js', 'b.js']));
  });

  it('differs when the set of files differs', () => {
    expect(hashFiles(['a.js'])).not.toBe(hashFiles(['a.js', 'b.js']));
  });
});

describe('chooseCarryForward', () => {
  it('carries forward the previous build’s own files when its manifest names a different release', () => {
    const previous = { id: 'old-id', files: ['old.js'] };
    const manifest = { current: previous, previous: { id: 'older-id', files: ['older.js'] } };
    expect(
      chooseCarryForward({ currentId: 'new-id', previousManifest: manifest, legacyAssetFiles: [] }),
    ).toEqual(previous);
  });

  it('carries forward what a patch rebuild’s own manifest already called "previous", not itself', () => {
    const olderGeneration = { id: 'older-id', files: ['older.js'] };
    const manifest = { current: { id: 'same-id', files: ['same.js'] }, previous: olderGeneration };
    expect(
      chooseCarryForward({
        currentId: 'same-id',
        previousManifest: manifest,
        legacyAssetFiles: [],
      }),
    ).toEqual(olderGeneration);
  });

  it('carries forward nothing when a patch rebuild’s manifest records no generation before it', () => {
    const manifest = { current: { id: 'same-id', files: ['same.js'] }, previous: null };
    expect(
      chooseCarryForward({
        currentId: 'same-id',
        previousManifest: manifest,
        legacyAssetFiles: [],
      }),
    ).toBeNull();
  });

  // The image live when this mechanism shipped (den-edge 0.251.0) published no manifest at all: without this
  // fallback, the very first build after this one would carry nothing forward and 404 the same way again.
  it('carries forward the whole of a previous image’s assets when it predates the manifest', () => {
    const legacyAssetFiles = ['legacy-a.js', 'legacy-b.js', 'legacy-a.js.gz'];
    const result = chooseCarryForward({
      currentId: 'new-id',
      previousManifest: null,
      legacyAssetFiles,
    });
    expect(result).toEqual({
      id: hashFiles(legacyAssetFiles),
      files: [...legacyAssetFiles].sort(),
    });
  });

  it('carries forward nothing when the manifest-less previous image is this exact build repeating', () => {
    const legacyAssetFiles = ['same-a.js', 'same-b.js'];
    const currentId = hashFiles(legacyAssetFiles);
    expect(chooseCarryForward({ currentId, previousManifest: null, legacyAssetFiles })).toBeNull();
  });

  it('carries forward nothing with no previous image at all (`scratch`) and no manifest to read either', () => {
    expect(
      chooseCarryForward({ currentId: 'new-id', previousManifest: null, legacyAssetFiles: [] }),
    ).toBeNull();
  });
});
