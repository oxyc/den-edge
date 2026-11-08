<script lang="ts">
  import RecoveryRedeem from '../src/components/RecoveryRedeem.svelte';
  import '../src/app.css';

  let shown = $state(true);
  let generation = $state(0);
  const opened: string[] = [];
  const controls = {
    unmount() {
      shown = false;
    },
    remount() {
      generation++;
      shown = true;
    },
    opened() {
      return [...opened];
    },
  };
  (
    globalThis as typeof globalThis & { recoveryRedeemFixture?: typeof controls }
  ).recoveryRedeemFixture = controls;
</script>

<main style="padding: 24px">
  {#if shown}
    {#key generation}
      <RecoveryRedeem onopen={(key) => (opened.push(key), true)} />
    {/key}
  {/if}
</main>
