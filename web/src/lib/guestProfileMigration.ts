import type { LibraryModel } from './libraryModel.svelte';

type GuestMigrationModel = Pick<
  LibraryModel,
  'profileMigrationStatus' | 'observeProfileMigration' | 'enableProfiles'
>;

export type GuestProfileMigrationOutcome = 'enabled' | 'pending' | 'unavailable';

/**
 * Resume or begin the one-time in-place Owner split for a guest household created by an older client. The edge
 * decides whether this exact authenticated household has guest provenance; this caller never receives another
 * household's id or keys.
 */
export async function migrateGuestProfiles(
  model: GuestMigrationModel,
): Promise<GuestProfileMigrationOutcome> {
  const status = await model.profileMigrationStatus();
  if (status.phase === 'enabled') return 'enabled';
  if (status.phase === 'off' || status.phase === 'recovery-required') return 'unavailable';
  if (status.phase !== 'available') return 'pending';

  const observed = await model.observeProfileMigration();
  const enabled = await model.enableProfiles(observed.attempt, observed.source);
  if (enabled.result.kind !== 'profile-migration.enable') return 'pending';
  if (enabled.result.outcome === 'enabled') return 'enabled';
  return enabled.result.outcome === 'recovery-required' ? 'unavailable' : 'pending';
}
