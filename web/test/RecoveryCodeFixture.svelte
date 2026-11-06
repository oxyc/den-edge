<script lang="ts">
  import RecoveryCode from '../src/settings/RecoveryCode.svelte';
  import type { LibraryModel } from '../src/lib/libraryModel.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import '../src/app.css';

  type Confirmation = 'committed' | 'pending' | 'lost';
  let shown = $state(true);
  let generation = $state(0);
  let outcomes: Array<Confirmation | 'hold'> = ['hold'];
  let abandonOutcomes: Array<'abandoned' | 'failed'> = [];
  // Fixture coordination is read explicitly through `recoveryFixture`, not rendered reactively.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const held = new Map<string, (outcome: Confirmation) => void>();
  const pending = new SvelteSet<string>();
  const events: Array<{ kind: 'confirm' | 'abandon'; locator: string }> = [];

  const controls = {
    unmount() {
      shown = false;
    },
    remount() {
      generation++;
      shown = true;
    },
    confirmations(next: Array<Confirmation | 'hold'>) {
      outcomes = [...next];
    },
    abandonments(next: Array<'abandoned' | 'failed'>) {
      abandonOutcomes = [...next];
    },
    release(locator: string, outcome: Confirmation) {
      held.get(locator)?.(outcome);
      held.delete(locator);
    },
    events() {
      return structuredClone(events);
    },
    held() {
      return [...held.keys()];
    },
    pending() {
      return [...pending];
    },
  };
  (globalThis as typeof globalThis & { recoveryFixture?: typeof controls }).recoveryFixture =
    controls;

  const confirm = (locator: string): Promise<Confirmation> => {
    events.push({ kind: 'confirm', locator });
    const outcome = outcomes.shift() ?? 'committed';
    return outcome === 'hold'
      ? new Promise((resolve) => held.set(locator, resolve))
      : Promise.resolve(outcome);
  };
  const abandon = async (locator: string) => {
    events.push({ kind: 'abandon', locator });
    const outcome = abandonOutcomes.shift() ?? 'abandoned';
    if (outcome === 'abandoned') pending.delete(locator);
    return outcome;
  };
  const authority = {
    sealRecovery: async () => ({ result: { kind: 'recovery.seal', sealed: 'sealed' } }),
    beginRecovery: async (locator: string) => {
      pending.add(locator);
      return { result: { kind: 'recovery.begin', outcome: 'begun' } };
    },
    confirmRecovery: async (locator: string) => {
      const outcome = await confirm(locator);
      return {
        result: {
          kind: 'recovery.confirm',
          outcome: outcome === 'committed' ? 'confirmed' : outcome === 'lost' ? 'lost' : 'failed',
        },
      };
    },
    abandonRecovery: async (locator: string) => {
      const outcome = await abandon(locator);
      return {
        result: { kind: 'recovery.abandon', outcome },
      };
    },
    disableRecovery: async () => ({ result: { kind: 'recovery.disable', outcome: 'disabled' } }),
  } as unknown as LibraryModel;
</script>

<main style="padding: 24px">
  {#if shown}
    {#key generation}
      <RecoveryCode
        view={{ availability: 'ready', live: null, broken: false, notices: [] }}
        ready={true}
        {authority}
        run={async (action) => (await action(), true)}
      />
    {/key}
  {/if}
</main>
