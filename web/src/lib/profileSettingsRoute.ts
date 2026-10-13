import type { ProfileIdentity } from './profileIdentity';
import type { ProfilePreferences } from './profilePreferences.svelte';
import type { ActiveProfileMode } from './profileModeCoordinator.svelte';
import type { LibraryModel } from './libraryModel.svelte';

export type ProfileSettingsRoute = 'personal' | 'unavailable' | 'household';

/** Keep every non-Owner profile away from the household Settings shell, including damaged preference state. */
export function profileSettingsRoute(
  session: {
    readonly identity: ProfileIdentity;
    readonly preferences: ProfilePreferences | null;
  },
  mode: ActiveProfileMode | null,
): ProfileSettingsRoute {
  if (session.identity.kind === 'visitor') return session.preferences ? 'personal' : 'unavailable';
  if (session.identity.kind === 'profile')
    return mode === 'owner'
      ? 'household'
      : mode === 'kid' && session.preferences
        ? 'personal'
        : 'unavailable';
  return 'household';
}

/** Select household control state only for the two Owner routes; never lend it to Kid or Visitor Settings. */
export function profileHouseholdSettingsModel(
  session: Parameters<typeof profileSettingsRoute>[0] & {
    readonly household: { ownerSettingsModel(): LibraryModel | null };
  },
  mode: ActiveProfileMode | null,
): LibraryModel | null {
  return profileSettingsRoute(session, mode) === 'household'
    ? session.household.ownerSettingsModel()
    : null;
}
