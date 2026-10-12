import { describe, expect, it } from 'vitest';
import {
  legacyProfileIdentity,
  persistentProfileIdentity,
  profileId,
  profileSessionKey,
  visitorProfileIdentity,
  visitorVisitId,
} from './profileIdentity';

const KID_ID = '0123456789abcdef0123456789abcdef';

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
    const kid = persistentProfileIdentity(KID_ID, 'kid-library-key');

    expect(kid).toMatchObject({
      kind: 'profile',
      id: KID_ID,
      libraryKey: 'kid-library-key',
      retainedScope: 'kid-library-key',
    });
    expect(profileSessionKey(kid)).toBe(`profile:${KID_ID}:kid-library-key`);
  });

  it('accepts only profiles-v1 lowercase 32-hex directory ids', () => {
    expect(profileId('00000000000000000000000000000000')).toBe('00000000000000000000000000000000');
    expect(profileId('ffffffffffffffffffffffffffffffff')).toBe('ffffffffffffffffffffffffffffffff');
    for (const invalid of [
      '',
      '0'.repeat(31),
      '0'.repeat(33),
      '0123456789ABCDEF0123456789ABCDEF',
      'g123456789abcdef0123456789abcdef',
      'owner',
      'personal',
      'public',
    ]) {
      expect(() => profileId(invalid), invalid).toThrow(TypeError);
      expect(() => persistentProfileIdentity(invalid, 'library-key'), invalid).toThrow(TypeError);
    }
  });

  it('keeps directory ids and internal sentinels in disjoint retained-state keys', () => {
    const libraryKey = 'same-library-key';
    const keys = [
      profileSessionKey(legacyProfileIdentity(libraryKey, false)),
      profileSessionKey(legacyProfileIdentity(libraryKey, true)),
      profileSessionKey(legacyProfileIdentity(null, false)),
      profileSessionKey(persistentProfileIdentity(KID_ID, libraryKey)),
      profileSessionKey(visitorProfileIdentity(KID_ID)),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps a visit outside the directory and personalized retained-state domains', () => {
    expect(visitorProfileIdentity(visitorVisitId(KID_ID))).toEqual({
      kind: 'visitor',
      id: KID_ID,
      libraryKey: null,
      retainedScope: null,
    });
    expect(profileSessionKey(visitorProfileIdentity(KID_ID))).toBe(`visitor:${KID_ID}:`);
    expect(() => visitorVisitId('visitor')).toThrow(TypeError);
  });
});
