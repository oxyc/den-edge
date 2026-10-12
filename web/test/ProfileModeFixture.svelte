<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ProfileSwitcher from '../src/components/ProfileSwitcher.svelte';
  import { HouseholdSession } from '../src/lib/householdSession.svelte';
  import type { LibraryModel, LibraryModelLease } from '../src/lib/libraryModel.svelte';
  import type { ConnectionsView } from '../src/lib/libraryServiceProtocol';
  import { legacyProfileIdentity } from '../src/lib/profileIdentity';
  import {
    ProfileModeCoordinator,
    profilesCapability,
  } from '../src/lib/profileModeCoordinator.svelte';
  import { ProfileSession } from '../src/lib/profileSession.svelte';
  import type { VisitorProfileSession } from '../src/lib/visitorProfileSession.svelte';

  const params = new URLSearchParams(location.search);
  const configured = params.get('pin') !== 'none';
  const release = () => {};
  const model = {
    settings: {
      connection: 'ready',
      value: { kind: 'settings', preferences: { maturityCeiling: 'pg13' } },
    },
    connections: () =>
      ({
        snapshot: {
          connection: 'ready',
          value: { kind: 'connections', parentalPinConfigured: configured },
        },
        release,
      }) as unknown as LibraryModelLease<ConnectionsView>,
    verifyParentalPin: async (pin: string) => pin === '1234',
    close: () => {},
  } as unknown as LibraryModel;
  const household = new HouseholdSession(
    { kind: 'legacy', libraryKey: 'fixture-household', configurationOnly: false },
    model,
    { query: async () => ({}), onStatus: () => () => {} },
  );
  const owner = new ProfileSession(
    legacyProfileIdentity('fixture-household', false),
    household,
    model,
    false,
    true,
  );
  let profiles = $state.raw<ProfileModeCoordinator | null>(null);
  let checked = $state(false);

  const fixture = {
    snapshot() {
      return {
        enabled: profiles !== null,
        checked,
        mode: profiles?.mode ?? 'owner',
        visitId: profiles?.mode === 'visitor' ? profiles.session.identity.id : null,
        policyCeiling: profiles?.session.policyModel?.settings.value?.preferences.maturityCeiling,
        keys: Object.keys(localStorage).sort(),
      };
    },
    setActivity(key: string, value: string) {
      (profiles?.session as VisitorProfileSession).activity.set(key, value);
    },
    getActivity(key: string) {
      return (profiles?.session as VisitorProfileSession).activity.get(key);
    },
    outbound() {
      const visitor = profiles?.session as VisitorProfileSession;
      return Promise.all([
        visitor.outbound.write({
          kind: 'progress.record',
          title: { type: 'movie', id: 550 },
          fraction: 0.5,
          seconds: 60,
          observedAt: 1,
        }),
        visitor.outbound.track({ schema: 1 }),
      ]);
    },
  };

  onMount(() => {
    let current = true;
    (window as typeof window & { denProfileModeFixture?: typeof fixture }).denProfileModeFixture =
      fixture;
    void profilesCapability().then((enabled) => {
      if (!current) return;
      if (enabled) profiles = new ProfileModeCoordinator(owner);
      checked = true;
    });
    return () => {
      current = false;
      delete (window as typeof window & { denProfileModeFixture?: typeof fixture })
        .denProfileModeFixture;
    };
  });

  onDestroy(() => (profiles ? profiles.dispose() : owner.close()));
</script>

<main>
  {#if !checked}
    <p role="status">Checking profiles…</p>
  {:else if profiles}
    <ProfileSwitcher {profiles} />
    <p data-mode>{profiles.mode === 'owner' ? 'Owner active' : 'Visitor active'}</p>
    {#if profiles.mode === 'visitor'}
      <p>Visitor can’t manage household settings.</p>
    {/if}
  {:else}
    <p data-mode>Legacy Owner active</p>
  {/if}
</main>

<style>
  main {
    display: grid;
    gap: 16px;
    max-width: 480px;
    margin: 40px auto;
  }
</style>
