import { describe, expect, it } from 'vitest';
import fixture from '../vendor/den-core/profiles-v1.json';
import {
  profileMigrationDigest,
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
});
