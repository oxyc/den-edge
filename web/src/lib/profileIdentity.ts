/** A stable profiles-v1 directory id: exactly 128 random bits rendered as lowercase hexadecimal. */
export type ProfileId = string & { readonly __profileId: unique symbol };

const PROFILE_ID = /^[0-9a-f]{32}$/;

export const profileId = (value: string): ProfileId => {
  if (!PROFILE_ID.test(value))
    throw new TypeError('A profile id must be exactly 32 lowercase hexadecimal characters');
  return value as ProfileId;
};

export interface PersistentProfileIdentity {
  readonly kind: 'profile';
  readonly id: ProfileId;
  readonly libraryKey: string;
  readonly retainedScope: string;
}

export type ProfileIdentity =
  | PersistentProfileIdentity
  | {
      readonly kind: 'owner';
      readonly id: ProfileId;
      readonly libraryKey: string;
      /** Keep today's cache/storage namespace until the explicit profile split supplies a profile library key. */
      readonly retainedScope: string;
    }
  | {
      readonly kind: 'personal';
      readonly id: ProfileId;
      readonly libraryKey: string;
      readonly retainedScope: string;
    }
  | {
      readonly kind: 'public';
      readonly id: ProfileId;
      readonly libraryKey: null;
      readonly retainedScope: null;
    };

type SentinelId = 'owner' | 'personal' | 'public';
// These identities exist only before a directory-backed profile is active. Keep them visibly outside profiles-v1's
// 32-hex domain so neither a decoded directory entry nor a retained-state key can collide with one.
const sentinelId = (value: SentinelId): ProfileId => value as ProfileId;
const OWNER_ID = sentinelId('owner');
const PERSONAL_ID = sentinelId('personal');
const PUBLIC_ID = sentinelId('public');

/** A directory-backed persistent profile (Kid today, and any later persistent profile) uses the same seam. */
export const persistentProfileIdentity = (
  id: string,
  libraryKey: string,
): PersistentProfileIdentity => ({
  kind: 'profile',
  id: profileId(id),
  libraryKey,
  retainedScope: libraryKey,
});

/**
 * The inactive compatibility topology: a linked library is both today's mixed household log and the Owner profile.
 * No key, cache namespace, storage row or request changes until an explicit profile directory exists.
 */
export function legacyProfileIdentity(libraryKey: string | null, local: boolean): ProfileIdentity {
  if (libraryKey === null)
    return { kind: 'public', id: PUBLIC_ID, libraryKey: null, retainedScope: null };
  return local
    ? { kind: 'personal', id: PERSONAL_ID, libraryKey, retainedScope: libraryKey }
    : { kind: 'owner', id: OWNER_ID, libraryKey, retainedScope: libraryKey };
}

/** Keys the entire retained route/presentation tree by the typed active profile, including legacy key resets. */
export const profileSessionKey = (identity: ProfileIdentity): string =>
  `${identity.kind}:${identity.id}:${identity.libraryKey ?? ''}`;
