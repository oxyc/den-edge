/** A stable profile-directory id. The constructor keeps arbitrary strings out of profile-scoped state keys. */
export type ProfileId = string & { readonly __profileId: unique symbol };

export const profileId = (value: string): ProfileId => {
  if (!value) throw new TypeError('A profile id must not be empty');
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

const OWNER_ID = profileId('owner');
const PERSONAL_ID = profileId('personal');
const PUBLIC_ID = profileId('public');

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
