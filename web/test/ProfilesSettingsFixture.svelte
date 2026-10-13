<script lang="ts">
  import ProfilesSection from '../src/settings/ProfilesSection.svelte';
  import type { LibraryModel } from '../src/lib/libraryModel.svelte';

  const attempt = '0123456789abcdef0123456789abcdef';
  const source = { generation: 7, head: 'a'.repeat(64) };
  const events: string[] = [];
  const recovering = new URLSearchParams(location.search).has('recovery');
  let phase = (recovering ? 'recovery-required' : 'available') as
    'available' | 'enabled' | 'recovery-required';
  let savedPin = recovering ? '1234' : '';

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
    observeProfileRecovery: async (askedAttempt: string) => {
      events.push(`observe-recovery:${askedAttempt}`);
      return {
        kind: 'profile-migration.observe-recovery' as const,
        attempt: askedAttempt,
        recoveryAttempt: 'f'.repeat(32),
        source,
      };
    },
    recoverProfileMigration: async (
      askedAttempt: string,
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
  } as unknown as LibraryModel;

  (globalThis as { profileSettingsEvents?: () => string[] }).profileSettingsEvents = () => [
    ...events,
  ];
</script>

<main style="max-width:760px;margin:40px auto">
  <ProfilesSection
    {model}
    pinConfigured={recovering}
    savePin={async (pin) => {
      events.push(`set:${pin}`);
      savedPin = pin;
      return true;
    }}
    verifyPin={async (pin) => {
      events.push(`verify:${pin}`);
      return pin === savedPin;
    }}
  />
</main>
