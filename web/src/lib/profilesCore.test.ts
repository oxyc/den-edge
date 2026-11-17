import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import {
  profilesConstructDirectory,
  profilesResetNext,
  profilesSnapshotDigest,
} from './profilesCore';

interface DigestCase {
  name: string;
  request: {
    op: string;
    kind: 'source' | 'owner';
    input: Record<string, unknown>;
  };
  ok?: string;
  error?: string;
}

describe('persistent profiles den-core boundary', () => {
  it('matches every neutral snapshot digest vector', () => {
    const vectors = (fixture.cases as DigestCase[]).filter(
      ({ request }) =>
        request.op === 'profiles_snapshot_digest' &&
        (request.kind === 'source' || request.kind === 'owner'),
    );
    expect(vectors.length).toBeGreaterThanOrEqual(2);
    for (const vector of vectors) {
      const digest = () =>
        vector.request.kind === 'source'
          ? profilesSnapshotDigest('source', vector.request.input as never)
          : profilesSnapshotDigest('owner', vector.request.input as never);
      if (vector.error) expect(digest, vector.name).toThrow(vector.error);
      else expect(digest(), vector.name).toBe(vector.ok);
    }
  });

  it('constructs the committed directory through the neutral operation', () => {
    const constructed = profilesConstructDirectory(
      fixture.initialDirectoryConstructorInput as Record<string, unknown>,
    );
    const expected = fixture.initialDirectoryConstructorCases[0]!.expect!;
    // JavaScript preserves a parsed negative zero while RFC 8785 canonicalizes it to zero.
    expect(constructed.directory).toEqual(JSON.parse(JSON.stringify(expected.directory)));
    expect(constructed.jcs).toBe(expected.jcs);
    expect(constructed.plaintext).toBe(expected.plaintext);
    expect(constructed.jcs).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(constructed.plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('drives the exact compound-reset sequence across the vendored policy boundary', () => {
    const input = resetInput();
    const profiles = input.profiles as ResetEvidence[];
    const profileIDs = profiles.map(({ profile }) => profile);

    expect(profilesResetNext(input)).toEqual({
      effect: 'move-live-profiles',
      profiles: profileIDs,
    });

    const verified = profiles.map((profile) => ({
      ...profile,
      copiedHead: 'e'.repeat(64),
      verified: true,
    }));
    expect(profilesResetNext({ ...input, profiles: verified })).toEqual({
      effect: 'commit-successor-household',
    });

    const partiallyRetired = verified.map((profile, index) => ({
      ...profile,
      oldRetired: index === 0,
    }));
    expect(
      profilesResetNext({
        ...input,
        profiles: partiallyRetired,
        householdCommitted: true,
      }),
    ).toEqual({
      effect: 'retire-old-libraries',
      profiles: profileIDs.slice(1),
      household: true,
    });

    const retiredProfiles = verified.map((profile) => ({ ...profile, oldRetired: true }));
    expect(
      profilesResetNext({
        ...input,
        profiles: retiredProfiles,
        householdCommitted: true,
      }),
    ).toEqual({ effect: 'retire-old-libraries', profiles: [], household: true });
    expect(
      profilesResetNext({
        ...input,
        profiles: retiredProfiles,
        householdCommitted: true,
        oldHouseholdRetired: true,
      }),
    ).toEqual({ effect: 'complete' });
  });

  it('rejects incomplete or invented live-profile evidence', () => {
    const input = resetInput();
    const profiles = input.profiles as ResetEvidence[];

    expect(() => profilesResetNext({ ...input, profiles: profiles.slice(0, -1) })).toThrow();
    expect(() => profilesResetNext({ ...input, profiles: [...profiles, profiles[0]] })).toThrow();
    expect(() =>
      profilesResetNext({
        ...input,
        profiles: [
          { ...profiles[0], profile: 'ffffffffffffffffffffffffffffffff' },
          ...profiles.slice(1),
        ],
      }),
    ).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects inexact reset-fence generation %s',
    (generation) => {
      const input = resetInput();
      expect(() =>
        profilesResetNext({ ...input, fence: { ...input.fence, generation } }),
      ).toThrow();
    },
  );
});

interface ResetEvidence {
  readonly profile: string;
  readonly oldKey: string;
  readonly newKey: string;
  readonly oldVersion: number;
  readonly newVersion: number;
  readonly copiedHead: string | null;
  readonly verified: boolean;
  readonly oldRetired: boolean;
}

function resetInput() {
  const directory = structuredClone(fixture.migrationBase) as {
    profiles: Record<string, { library: { value: { key: string; keyVersion: number } } }>;
  };
  const keys = [
    'REREREREREREREREREREREREREREREREREREREREREQ=',
    'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=',
    'ZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmY=',
  ];
  const profiles = Object.keys(directory.profiles)
    .sort()
    .map((profile, index): ResetEvidence => {
      const library = directory.profiles[profile]!.library.value;
      return {
        profile,
        oldKey: library.key,
        newKey: keys[index]!,
        oldVersion: library.keyVersion,
        newVersion: library.keyVersion + 1,
        copiedHead: null,
        verified: false,
        oldRetired: false,
      };
    });
  return {
    directory,
    fence: { generation: 14, head: 'd'.repeat(64) },
    profiles,
    householdCommitted: false,
    oldHouseholdRetired: false,
  };
}
