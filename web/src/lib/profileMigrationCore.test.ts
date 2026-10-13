import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import {
  profileMigrationAuthorizationFingerprint,
  profileMigrationConstructDirectory,
  profileMigrationDigest,
  profileMigrationMaterialize,
  profileMigrationPartition,
  validMigrationSnapshot,
  type MigrationBackupManifest,
  type MigrationSnapshotRow,
} from './profileMigrationCore';

interface DigestCase {
  name: string;
  request: {
    kind: 'source' | 'backup' | 'staged' | 'owner';
    input: Record<string, unknown>;
  };
  ok: string;
}

const cases = (fixture.cases as DigestCase[]).filter(({ request }) =>
  ['source', 'backup', 'staged', 'owner'].includes(request.kind),
);

interface CoreCase {
  name: string;
  request: { op: string; input: Record<string, unknown> };
  ok?: unknown;
  error?: string;
}

describe('profile migration den-core boundary', () => {
  it('matches every vendored profiles-v1 migration digest vector', () => {
    expect(cases).toHaveLength(4);
    for (const vector of cases)
      expect(
        profileMigrationDigest(vector.request.kind as 'staged', vector.request.input as never),
        vector.name,
      ).toBe(vector.ok);
  });

  it('fails closed on duplicate, malformed and unsafe snapshot authority', () => {
    const row: MigrationSnapshotRow = { k: 'a'.repeat(64), seq: 1, v: 'sealed' };
    expect(
      validMigrationSnapshot({ libraryId: '1'.repeat(32), base: 1, wireMin: 4, rows: [row] }),
    ).toBe(true);
    expect(
      validMigrationSnapshot({
        libraryId: '1'.repeat(32),
        base: 1,
        wireMin: 4,
        rows: [row, row],
      }),
    ).toBe(false);
    expect(
      validMigrationSnapshot({ libraryId: '1'.repeat(32), base: 0, wireMin: 4, rows: [row] }),
    ).toBe(false);
    expect(() =>
      profileMigrationDigest('backup', {
        id: '',
        householdId: '1'.repeat(32),
        attempt: '2'.repeat(32),
        source: { generation: 0, base: 1, head: '3'.repeat(64), rewrite: 'rewrite' },
        wireMin: 4,
        authorization: { tokenHash: '4'.repeat(64), memberHash: null },
        rows: [row],
      } satisfies MigrationBackupManifest),
    ).toThrow(/invalid_migration_digest/);
  });

  it('matches every vendored partition, materialize, directory and authorization vector', () => {
    const operations = new Map<string, (input: Record<string, unknown>) => unknown>([
      ['profiles_migration_partition_rows', (input) => profileMigrationPartition(input as never)],
      [
        'profiles_migration_materialize_plaintext',
        (input) => profileMigrationMaterialize(input as never),
      ],
      ['profiles_migration_construct_directory', profileMigrationConstructDirectory],
      [
        'profiles_migration_authorization_fingerprint',
        (input) => profileMigrationAuthorizationFingerprint(input as never),
      ],
    ]);
    const vectors = (fixture.cases as CoreCase[]).filter(({ request }) =>
      operations.has(request.op),
    );
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    for (const vector of vectors) {
      const operation = operations.get(vector.request.op)!;
      if (vector.error)
        expect(() => operation(vector.request.input), vector.name).toThrow(vector.error);
      else expect(operation(vector.request.input), vector.name).toEqual(vector.ok);
    }
  });
});
