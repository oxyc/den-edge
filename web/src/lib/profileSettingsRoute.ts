import type { ProfileIdentity } from './profileIdentity';
import type { ProfilePreferences } from './profilePreferences.svelte';
import type { ActiveProfileMode } from './profileModeCoordinator.svelte';

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
    return mode === 'kid' && session.preferences ? 'personal' : 'unavailable';
  return 'household';
}
