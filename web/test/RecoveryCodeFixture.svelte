<script lang="ts">
  import RecoveryCode from '../src/settings/RecoveryCode.svelte';
  import type {
    RecoveryAbandonOutcome,
    RecoveryConfirmationOutcome,
  } from '../src/settings/recoveryConfirmation';
  import '../src/app.css';

  const locators = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)];
  const codes = [
    'AAAA-AAAA-AAAA-AAAA-AAAA-1111',
    'BBBB-BBBB-BBBB-BBBB-BBBB-2222',
    'CCCC-CCCC-CCCC-CCCC-CCCC-3333',
    'DDDD-DDDD-DDDD-DDDD-DDDD-4444',
  ];
  let material = 0;
  let shown = $state(true);
  let generation = $state(0);
  let outcomes: Array<RecoveryConfirmationOutcome | 'hold'> = ['hold'];
  // Fixture coordination is read explicitly through `recoveryFixture`, not rendered reactively.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const held = new Map<string, (outcome: RecoveryConfirmationOutcome) => void>();
  const events: Array<{ kind: 'confirm' | 'abandon'; locator: string }> = [];

  const controls = {
    unmount() {
      shown = false;
    },
    remount() {
      generation++;
      shown = true;
    },
    confirmations(next: Array<RecoveryConfirmationOutcome | 'hold'>) {
      outcomes = [...next];
    },
    release(locator: string, outcome: RecoveryConfirmationOutcome) {
      held.get(locator)?.(outcome);
      held.delete(locator);
    },
    events() {
      return structuredClone(events);
    },
    held() {
      return [...held.keys()];
    },
  };
  (globalThis as typeof globalThis & { recoveryFixture?: typeof controls }).recoveryFixture =
    controls;

  const confirm = (locator: string): Promise<RecoveryConfirmationOutcome> => {
    events.push({ kind: 'confirm', locator });
    const outcome = outcomes.shift() ?? { state: 'committed' };
    return outcome === 'hold'
      ? new Promise((resolve) => held.set(locator, resolve))
      : Promise.resolve(outcome);
  };
  const abandon = async (locator: string): Promise<RecoveryAbandonOutcome> => {
    events.push({ kind: 'abandon', locator });
    return { state: 'abandoned' };
  };
</script>

<main style="padding: 24px">
  {#if shown}
    {#key generation}
      <RecoveryCode
        view={{ availability: 'ready', live: null, broken: false, notices: [] }}
        ready={true}
        makeCode={async () => {
          const index = material++;
          return {
            code: codes[index]!,
            locator: locators[index]!,
            wrapKey: new Uint8Array(32).fill(index + 1),
          };
        }}
        seal={async () => 'sealed'}
        begin={async () => 'begun'}
        confirm={(locator) => confirm(locator)}
        {abandon}
        disable={async () => true}
      />
    {/key}
  {/if}
</main>
