import { describe, expect, it } from 'vitest';
import {
  legacyProfileIdentity,
  persistentProfileIdentity,
  profileSessionKey,
} from './profileIdentity';

describe('profile identity', () => {
  it('maps the unchanged linked path to Owner while preserving its cache and library key', () => {
    const identity = legacyProfileIdentity('current-library-key', false);

    expect(identity).toMatchObject({
      kind: 'owner',
      id: 'owner',
      libraryKey: 'current-library-key',
      retainedScope: 'current-library-key',
    });
    expect(profileSessionKey(identity)).toBe('owner:owner:current-library-key');
  });

  it('keeps a browser-personal library and public browsing distinct from household profiles', () => {
    expect(legacyProfileIdentity('local-key', true)).toMatchObject({
      kind: 'personal',
      retainedScope: 'local-key',
    });
    expect(legacyProfileIdentity(null, false)).toMatchObject({
      kind: 'public',
      libraryKey: null,
      retainedScope: null,
    });
  });

  it('gives every future persistent profile the same typed library and retained-state seam', () => {
    const kid = persistentProfileIdentity('kid-a', 'kid-library-key');

    expect(kid).toMatchObject({
      kind: 'profile',
      id: 'kid-a',
      libraryKey: 'kid-library-key',
      retainedScope: 'kid-library-key',
    });
    expect(profileSessionKey(kid)).toBe('profile:kid-a:kid-library-key');
  });

  it('refuses an empty persistent profile id before it can key retained state', () => {
    expect(() => persistentProfileIdentity('', 'library-key')).toThrow(TypeError);
  });
});
