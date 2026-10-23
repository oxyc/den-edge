import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import { profilesConstructDirectory, profilesSnapshotDigest } from './profilesCore';

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
      fixture.migrationDirectoryConstructorInput as Record<string, unknown>,
    );
    const expected = fixture.migrationDirectoryConstructorCases[0]!.expect!;
    // JavaScript preserves a parsed negative zero while RFC 8785 canonicalizes it to zero.
    expect(constructed.directory).toEqual(JSON.parse(JSON.stringify(expected.directory)));
    expect(constructed.jcs).toBe(expected.jcs);
    expect(constructed.plaintext).toBe(expected.plaintext);
    expect(constructed.jcs).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(constructed.plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
