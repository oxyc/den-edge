<script lang="ts">
  import ProfilesSection from '../src/settings/ProfilesSection.svelte';
  import type { LibraryModel } from '../src/lib/libraryModel.svelte';

  const attempt = '0123456789abcdef0123456789abcdef';
  const source = { generation: 7, head: 'a'.repeat(64) };
  const events: string[] = [];
  const recovering = new URLSearchParams(location.search).has('recovery');
  const queued = new URLSearchParams(location.search).has('queued');
  const reloadedPending = new URLSearchParams(location.search).has('reloaded-pending');
  const enabled = new URLSearchParams(location.search).has('enabled');
  // Another device (or a lost journal) holds the exclusive migration lock: no split journal on this device.
  const locked = new URLSearchParams(location.search).has('locked');
  let phase = (
    recovering
      ? 'recovery-required'
      : locked
        ? 'setup-in-progress'
        : enabled
          ? 'enabled'
          : 'available'
  ) as 'available' | 'enabled' | 'recovery-required' | 'setup-in-progress';
  let savedPin = recovering || enabled || locked ? '1234' : '';

  const model = {
    profileMigrationStatus: async () => ({
      kind: 'profile-migration.status' as const,
      phase,
      ...(recovering && phase === 'recovery-required' ? { attempt } : {}),
    }),
    observeProfileMigration: async () => {
      events.push('observe');
      return { kind: 'profile-migration.observe' as const, attempt, source };
    },
    enableProfiles: async (askedAttempt: string, askedSource: typeof source) => {
      events.push(`enable:${askedAttempt}:${askedSource.generation}:${askedSource.head}`);
      phase = 'enabled';
      return { result: { kind: 'profile-migration.enable', outcome: 'enabled' }, affected: [] };
    },
    observeProfileRecovery: async (askedAttempt: string | null) => {
      events.push(`observe-recovery:${askedAttempt}`);
      return {
        kind: 'profile-migration.observe-recovery' as const,
        attempt: askedAttempt,
        recoveryAttempt: 'f'.repeat(32),
        source,
      };
    },
    recoverProfileMigration: async (
      askedAttempt: string | null,
      recoveryAttempt: string,
      askedSource: typeof source,
    ) => {
      events.push(
        `recover:${askedAttempt}:${recoveryAttempt}:${askedSource.generation}:${askedSource.head}`,
      );
      phase = 'enabled';
      return { result: { kind: 'profile-migration.recover', outcome: 'enabled' }, affected: [] };
    },
    cancelProfileMigration: async () => {
      throw new Error('not preparing');
    },
    profileCreateStatus: async () => ({
      kind: 'profile-create.status' as const,
      phase: 'idle' as const,
    }),
    createKidProfile: async (name: string, maximumAge: number, pin: string) => {
      events.push(`create:${name}:${maximumAge}:${pin}`);
      return {
        result: {
          kind: 'profile.create' as const,
          outcome: 'created' as const,
          profile: 'b'.repeat(32),
          name,
          maximumAge,
          receipt: 'fixture-profile-create',
        },
        affected: [],
      };
    },
  } as unknown as LibraryModel;

  (globalThis as { profileSettingsEvents?: () => string[] }).profileSettingsEvents = () => [
    ...events,
  ];
</script>

<main style="max-width:760px;margin:40px auto">
  <ProfilesSection
    {model}
    pinConfigured={recovering || reloadedPending || enabled || locked}
    pinDelivery={reloadedPending ? 'queued' : 'synced'}
    savePin={async (pin) => {
      events.push(`set:${pin}`);
      savedPin = pin;
      return queued ? 'queued' : 'synced';
    }}
    verifyPin={async (pin) => {
      events.push(`verify:${pin}`);
      return pin === savedPin;
    }}
  />
</main>
