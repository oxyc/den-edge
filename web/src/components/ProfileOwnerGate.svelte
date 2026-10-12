<script lang="ts">
  import { tick } from 'svelte';
  import type { ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';
  import PinInput from './PinInput.svelte';

  let { profiles }: { profiles: ProfileModeCoordinator } = $props();
  let pin = $state('');
  let denied = $state(false);
  let failed = $state(false);
  let establishing = $state(false);
  let gate = $state<HTMLElement>();

  async function establishOwner() {
    if (establishing) return;
    establishing = true;
    denied = false;
    failed = false;
    try {
      if (!(await profiles.switchToOwner(pin))) denied = true;
    } catch {
      failed = true;
    } finally {
      establishing = false;
      pin = '';
    }
    await tick();
    requestAnimationFrame(() =>
      gate?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }),
    );
  }
</script>

<section bind:this={gate} class="owner-gate" aria-labelledby="owner-gate-title">
  {#if profiles.parentalPinConfigured === undefined}
    <h1 id="owner-gate-title">Opening profiles…</h1>
    <p role="status">Checking parental controls…</p>
  {:else}
    <h1 id="owner-gate-title">Owner access</h1>
    <p>Enter the Owner PIN to use the household library.</p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (/^\d{4}$/.test(pin)) void establishOwner();
      }}
    >
      <PinInput
        id="owner-gate-pin"
        label="Owner PIN"
        bind:value={pin}
        focusOnMount
        invalid={denied}
        onvalue={() => (denied = false)}
        oncomplete={() => void establishOwner()}
      />
      {#if denied}<p class="denied" role="alert">That PIN didn’t match.</p>{/if}
      {#if failed}<p class="denied" role="alert">Owner couldn’t be opened. Try again.</p>{/if}
      <button type="submit" disabled={establishing || !/^\d{4}$/.test(pin)}>
        {establishing ? 'Opening…' : 'Use Owner'}
      </button>
    </form>
  {/if}
</section>

<style>
  .owner-gate {
    display: grid;
    gap: 16px;
    max-width: 420px;
    margin: 48px auto;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--card);
  }

  h1,
  p {
    margin: 0;
  }

  p {
    color: var(--muted);
  }

  form {
    display: grid;
    gap: 10px;
  }

  button {
    justify-self: end;
    min-height: 36px;
    padding: 0 14px;
    border: 0;
    border-radius: 9px;
    background: var(--accent);
    color: var(--accent-contrast, #fff);
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .denied {
    color: var(--bad, #ff9a9a);
  }
</style>
