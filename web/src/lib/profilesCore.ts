import { syncPolicy } from './syncCore';
import type { ProfileDirectoryDocument } from './profileDirectory';
import type { Stamp } from './wire';

const DIGEST = /^[0-9a-f]{64}$/;

export interface ProfilesSnapshotRow {
  readonly k: string;
  readonly seq: number;
  readonly v: string;
}

export interface ProfilesDirectoryConstruction {
  readonly directory: unknown;
  /** RFC 8785 directory bytes, base64url without padding. */
  readonly jcs: string;
  /** Exact compressed library-v4 plaintext to seal, base64url without padding. */
  readonly plaintext: string;
}

export interface ProfileCreateJournal {
  readonly version: 1;
  readonly profile: string;
  /** Base64 profile key. It is valid only inside the household-sealed Worker journal. */
  readonly key: string;
  readonly display: {
    readonly value: { readonly name: string; readonly avatar?: string };
    readonly at: readonly [number, number, string];
  };
  readonly libraryAt: readonly [number, number, string];
  readonly maximumAge: number;
  readonly policyAt: readonly [number, number, string];
  readonly deletedAt: readonly [number, number, string];
}

export type ProfileCreateEffect =
  | { readonly effect: 'no-op' | 'persist-journal' | 'read-directory' | 'discard-journal' }
  | {
      readonly effect: 'create-profile-library' | 'retire-profile-library';
      readonly profile: string;
      readonly key: string;
    }
  | { readonly effect: 'apply-create'; readonly profile: string; readonly entry: unknown }
  | {
      readonly effect: 'cas-directory';
      readonly base: number;
      readonly generation: string;
      readonly directory: unknown;
    }
  | { readonly effect: 'adopt'; readonly directory: unknown };

export interface ProfileDirectoryMaterialization {
  readonly directory: ProfileDirectoryDocument;
  /** RFC 8785 directory bytes, base64url without padding. */
  readonly jcs: string;
  /** Exact compressed library-v4 plaintext, base64url without padding. */
  readonly plaintext: string;
}

/** Authenticated source or profile-library digest shared by born households and compound reset. */
export function profilesSnapshotDigest(
  kind: 'source',
  input: {
    readonly libraryId: string;
    readonly generation: number;
    readonly base: number;
    readonly wireMin: number;
    readonly rows: readonly ProfilesSnapshotRow[];
  },
): string;
export function profilesSnapshotDigest(
  kind: 'owner',
  input: {
    readonly libraryId: string;
    readonly base: number;
    readonly wireMin: number;
    readonly rows: readonly ProfilesSnapshotRow[];
  },
): string;
export function profilesSnapshotDigest(kind: 'source' | 'owner', input: unknown): string {
  const digest = syncPolicy<string>({ op: 'profiles_snapshot_digest', kind, input });
  if (!DIGEST.test(digest)) throw new Error('den-core returned an invalid profile snapshot digest');
  return digest;
}

/** Build and validate the first committed directory for a born profile-aware household. */
export function profilesConstructDirectory(
  input: Record<string, unknown>,
): ProfilesDirectoryConstruction {
  return syncPolicy<ProfilesDirectoryConstruction>({
    op: 'profiles_construct_directory',
    input,
  });
}

export function profilesMaterialize(document: unknown): ProfileDirectoryMaterialization {
  return syncPolicy<ProfileDirectoryMaterialization>({ op: 'profiles_materialize', document });
}

/** Apply the journal-derived Kid entry. den-core forces unknown ratings closed and validates the complete result. */
export function profilesApplyCreate(input: {
  readonly document: ProfileDirectoryDocument;
  readonly profile: string;
  readonly entry: unknown;
}): ProfileDirectoryDocument {
  return syncPolicy<ProfileDirectoryDocument>({
    op: 'profiles_apply',
    document: input.document,
    operation: 'create',
    profile: input.profile,
    entry: input.entry,
  });
}

/** Set one Kid's content policy through den-core's stamped operation, which validates the complete result. */
export function profilesApplyPolicy(input: {
  readonly document: ProfileDirectoryDocument;
  readonly profile: string;
  readonly maximumAge: number | null;
  readonly unknownRatings: 'allow' | 'block';
  readonly at: Stamp;
}): ProfileDirectoryDocument {
  return syncPolicy<ProfileDirectoryDocument>({
    op: 'profiles_apply',
    document: input.document,
    operation: 'policy',
    profile: input.profile,
    value: { maximumAge: input.maximumAge, unknownRatings: input.unknownRatings },
    at: input.at,
  });
}

/**
 * Rotate one live profile's library register through den-core's canonical stamped operation. A compound reset
 * applies this once per verified candidate with one durable fresh stamp; Web never patches the register itself.
 */
export function profilesRotateLibrary(input: {
  readonly document: ProfileDirectoryDocument;
  readonly profile: string;
  readonly keyVersion: number;
  readonly key: string;
  readonly at: Stamp;
}): ProfileDirectoryDocument {
  return syncPolicy<ProfileDirectoryDocument>({
    op: 'profiles_apply',
    document: input.document,
    operation: 'library',
    profile: input.profile,
    value: { keyVersion: input.keyVersion, key: input.key },
    at: input.at,
  });
}

/** Merge two authenticated directory observations using the one shared CRDT rule. */
export function profilesMerge(
  left: ProfileDirectoryDocument,
  right: ProfileDirectoryDocument,
): ProfileDirectoryDocument {
  return syncPolicy<ProfileDirectoryDocument>({ op: 'profiles_merge', a: left, b: right });
}

/** Pure crash/retry/concurrency planner for one explicitly requested persistent Kid profile. */
export function profilesCreateNext(input: Record<string, unknown>): ProfileCreateEffect {
  return syncPolicy<ProfileCreateEffect>({ op: 'profiles_create_next', input });
}

export type ProfileResetEffect =
  | { readonly effect: 'move-live-profiles'; readonly profiles: readonly string[] }
  | { readonly effect: 'commit-successor-household' }
  | {
      readonly effect: 'retire-old-libraries';
      readonly profiles: readonly string[];
      readonly household: boolean;
    }
  | { readonly effect: 'complete' };

/** Pure planner for the compound household key reset (profiles-v1 §9). Callers execute exactly what it returns. */
export function profilesResetNext(input: Record<string, unknown>): ProfileResetEffect {
  return syncPolicy<ProfileResetEffect>({ op: 'profiles_reset_next', input });
}
