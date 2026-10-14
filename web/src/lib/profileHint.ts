import type { ProfileChoice } from './profileModeCoordinator.svelte';
import { readActiveProfile } from './profileModeCoordinator.svelte';

const PROFILE_HINT_KEY = 'den.profile.hint.v1';

/** What the first frame needs to draw a remembered Owner before the profile session has opened. */
export interface ProfileHint {
  readonly version: 1;
  readonly profileId: string;
  readonly name: string;
  readonly avatar: string;
}

/**
 * The hint for the remembered persistent Owner, or null. It only counts while the active-profile marker still names
 * the same profile, so a stale or damaged hint falls back to waiting for the coordinator. Only an Owner is ever
 * drawn optimistically: a Kid must never see the Owner library, even for a frame.
 */
export function readProfileHint(storage: Storage = localStorage): ProfileHint | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(PROFILE_HINT_KEY) ?? 'null');
    const marker = readActiveProfile(storage);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('profileId' in value) ||
      typeof value.profileId !== 'string' ||
      !('name' in value) ||
      typeof value.name !== 'string' ||
      value.name.length > 64 ||
      !('avatar' in value) ||
      typeof value.avatar !== 'string' ||
      value.avatar.length > 32 ||
      marker?.mode !== 'persistent' ||
      marker.profileId !== value.profileId
    )
      return null;
    return { version: 1, profileId: value.profileId, name: value.name, avatar: value.avatar };
  } catch {
    return null;
  }
}

/** Remember the settled profile, or forget it when the browser is not on a persistent Owner. */
export function saveProfileHint(choice: ProfileChoice | null, storage: Storage = localStorage) {
  try {
    if (choice?.role === 'owner' && choice.id) {
      const hint: ProfileHint = {
        version: 1,
        profileId: choice.id,
        name: choice.name,
        avatar: choice.avatar,
      };
      storage.setItem(PROFILE_HINT_KEY, JSON.stringify(hint));
    } else storage.removeItem(PROFILE_HINT_KEY);
  } catch {
    // The hint only speeds up the first frame; without it the page waits for the coordinator as before.
  }
}

/** The hint as a switcher choice. */
export const hintChoice = (hint: ProfileHint): ProfileChoice => ({
  id: hint.profileId as ProfileChoice['id'],
  role: 'owner',
  name: hint.name,
  avatar: hint.avatar,
});
