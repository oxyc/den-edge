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

export interface AuthenticatedMigrationRow extends MigrationSnapshotRow {
  readonly opened: unknown;
}

export type MigrationProjection =
  | {
      readonly source: { readonly k: string; readonly seq: number };
      readonly mode: 'preserve';
      readonly k: string;
      readonly v: string;
    }
  | {
      readonly source: { readonly k: string; readonly seq: number };
      readonly mode: 'materialize';
      readonly name: string;
      readonly row: unknown;
    };

export interface MigrationPartition {
  readonly household: readonly MigrationProjection[];
  readonly owner: readonly MigrationProjection[];
  readonly ownerPolicy: unknown;
  readonly accounting: readonly {
    readonly k: string;
    readonly seq: number;
    readonly destinations: readonly ('household' | 'owner')[];
  }[];
}

export interface MigrationMaterialization {
  /** RFC 8785 bytes, base64url without padding. */
  readonly jcs: string;
  /** Exact library-v4 plaintext to seal, base64url without padding. */
  readonly plaintext: string;
}

export interface MigrationAuthorizationFingerprint {
  readonly tokenHash: string;
  readonly memberHash: string | null;
}

export interface ProfileMigrationAuthorization {
  readonly intent: {
    readonly version: 1;
    readonly action: 'enable-profiles';
    readonly attempt: string;
    readonly householdId: string;
    readonly source: { readonly generation: number; readonly head: string };
  };
  readonly intentDigest: string;
  readonly commitBinding: string | null;
}

export type ProfileMigrationEffect =
  | 'no-op'
  | 'acquire-fence'
  | 'create-backup'
  | 'create-owner-library'
  | 'verify-owner-library'
  | 'record-commit-binding'
  | 'invalidate-authorization'
  | 'commit-fenced-household'
  | 'lookup-attempt'
  | 'read-household'
  | 'retry-bound-commit'
  | 'abort-attempt'
  | 'retire-losing-candidate'
  | 'discard-journal'
  | 'verify-winner'
  | 'activate'
  | 'recovery-blocked'
  | 'open-recovery-attempt'
  | 'restart'
  | 'cleanup_targets_winner';

export interface MigrationDirectoryConstruction {
  readonly directory: unknown;
  /** RFC 8785 directory bytes, base64url without padding. */
  readonly jcs: string;
  /** Exact compressed library-v4 plaintext to seal, base64url without padding. */
  readonly plaintext: string;
}

export interface ProfileCapabilityDecision {
  readonly state?: 'off' | 'prepare' | 'runtime';
  readonly effect:
    | 'not-found'
    | 'migration-wire-required'
    | 'authentication-required'
    | 'migration-storage'
    | 'serve-legacy'
    | 'serve-runtime'
    | 'update-required';
  readonly requiredWire?: number;
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

/** Exact row accounting for the one-time legacy household split. */
export function profileMigrationPartition(input: {
  readonly base: number;
  readonly ownerPolicyAt: readonly [number, number, string];
  readonly rows: readonly AuthenticatedMigrationRow[];
}): MigrationPartition {
  return syncPolicy<MigrationPartition>({ op: 'profiles_migration_partition_rows', input });
}

/** Exact bytes to seal for a materialized projection; callers cannot substitute JSON serialization. */
export function profileMigrationMaterialize(input: {
  readonly name: string;
  readonly row: unknown;
}): MigrationMaterialization {
  return syncPolicy<MigrationMaterialization>({
    op: 'profiles_migration_materialize_plaintext',
    input,
  });
}

/** Stored Owner directory constructor; validation is performed by the same den-core operation. */
export function profileMigrationConstructDirectory(
  input: Record<string, unknown>,
): MigrationDirectoryConstruction {
  return syncPolicy<MigrationDirectoryConstruction>({
    op: 'profiles_migration_construct_directory',
    input,
  });
}

/** The only Owner split lifecycle planner. Callers execute the returned effect but encode no transition policy. */
export function profileMigrationNext(input: Record<string, unknown>): ProfileMigrationEffect {
  return syncPolicy<ProfileMigrationEffect>({ op: 'profiles_migration_next', input });
}

/** Pure deployment/runtime capability decision; this does not expose or call a production endpoint. */
export function profileCapability(input: {
  readonly enrollment: 'off' | 'prepare';
  readonly wireMin: number;
  readonly directory: 'absent' | 'valid' | 'invalid';
  readonly request: 'ordinary' | 'migration';
  readonly wire: number;
  readonly authenticated: boolean;
}): ProfileCapabilityDecision {
  return syncPolicy<ProfileCapabilityDecision>({ op: 'profiles_capability', input });
}

/** Reproduce den-edge's SHA-256 credential-text authority without exposing credentials in a backup. */
export function profileMigrationAuthorizationFingerprint(input: {
  readonly token: string;
  readonly member: string | null;
}): MigrationAuthorizationFingerprint {
  return syncPolicy<MigrationAuthorizationFingerprint>({
    op: 'profiles_migration_authorization_fingerprint',
    input,
  });
}

/** Build or bind the exact one-shot Enable Profiles authorization. PIN verification remains a client effect. */
export function profileMigrationAuthorization(input: {
  readonly intent: ProfileMigrationAuthorization['intent'];
  readonly evidence: null | {
    readonly attempt: string;
    readonly householdId: string;
    readonly fence: { readonly generation: number; readonly head: string };
    readonly backupDigest: string;
    readonly candidateKey: string;
    readonly candidateHead: string;
    readonly stagedDigest: string;
    readonly wireMin: 5;
  };
}): ProfileMigrationAuthorization {
  return syncPolicy<ProfileMigrationAuthorization>({
    op: 'profiles_migration_authorization',
    input,
  });
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
