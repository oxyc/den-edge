import { syncPolicy } from './syncCore';

const DIGEST = /^[0-9a-f]{64}$/;
const LIBRARY_ID = /^[0-9a-f]{32}$/;
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface MigrationSealedRow {
  readonly k: string;
  readonly v: string;
}

export interface MigrationSnapshotRow extends MigrationSealedRow {
  readonly seq: number;
}

export interface MigrationDigestFence {
  readonly generation: number;
  readonly base: number;
  readonly head: string;
  readonly rewrite: string;
}

export interface MigrationBackupManifest {
  readonly id: string;
  readonly householdId: string;
  readonly attempt: string;
  readonly source: MigrationDigestFence;
  readonly wireMin: number;
  readonly authorization: {
    readonly tokenHash: string;
    readonly memberHash: string | null;
  };
  readonly rows: readonly MigrationSnapshotRow[];
}

/**
 * The only migration-digest boundary used by Web. Validation, raw-key ordering, RFC 8785 JCS and hashing stay in
 * den-core; callers cannot accidentally substitute JSON.stringify or a locale-sensitive sort.
 */
export function profileMigrationDigest(
  kind: 'source',
  input: {
    readonly libraryId: string;
    readonly generation: number;
    readonly base: number;
    readonly wireMin: number;
    readonly rows: readonly MigrationSnapshotRow[];
  },
): string;
export function profileMigrationDigest(kind: 'backup', input: MigrationBackupManifest): string;
export function profileMigrationDigest(
  kind: 'staged',
  input: { readonly rows: readonly MigrationSealedRow[] },
): string;
export function profileMigrationDigest(
  kind: 'owner',
  input: {
    readonly libraryId: string;
    readonly base: number;
    readonly wireMin: number;
    readonly rows: readonly MigrationSnapshotRow[];
  },
): string;
export function profileMigrationDigest(
  kind: 'source' | 'backup' | 'staged' | 'owner',
  input: unknown,
): string {
  const digest = syncPolicy<string>({ op: 'profiles_migration_digest', kind, input });
  if (!DIGEST.test(digest)) throw new Error('den-core returned an invalid migration digest');
  return digest;
}

/** Narrow early so malformed network evidence never reaches crypto or den-core as trusted state. */
export function validMigrationSnapshot(input: {
  readonly libraryId: string;
  readonly base: number;
  readonly wireMin: number;
  readonly rows: readonly MigrationSnapshotRow[];
}): boolean {
  if (
    !LIBRARY_ID.test(input.libraryId) ||
    !Number.isSafeInteger(input.base) ||
    input.base < 0 ||
    input.base > SAFE_INTEGER ||
    !Number.isSafeInteger(input.wireMin) ||
    input.wireMin < 1 ||
    input.wireMin > SAFE_INTEGER
  )
    return false;
  const keys = new Set<string>();
  const sequences = new Set<number>();
  return input.rows.every(
    ({ k, seq, v }) =>
      DIGEST.test(k) &&
      typeof v === 'string' &&
      Number.isSafeInteger(seq) &&
      seq > 0 &&
      seq <= input.base &&
      !keys.has(k) &&
      !sequences.has(seq) &&
      Boolean(keys.add(k)) &&
      Boolean(sequences.add(seq)),
  );
}
