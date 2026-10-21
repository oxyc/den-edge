<script lang="ts">
  import { tick } from 'svelte';
  import type { ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';
  import Button from './Button.svelte';
  import PinInput from './PinInput.svelte';

  let { profiles }: { profiles: ProfileModeCoordinator } = $props();
  let pin = $state('');
  let denied = $state(false);
  let failed = $state(false);
  let establishing = $state(false);
  let gate = $state<HTMLElement>();
  let pinReady = $derived(profiles.parentalPinConfigured === false || /^\d{4}$/.test(pin));

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
    <p>
      {profiles.parentalPinConfigured
        ? 'Enter the Owner PIN to continue.'
        : 'Continue to the Owner profile.'}
    </p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (pinReady) void establishOwner();
      }}
    >
      {#if profiles.parentalPinConfigured}
        <PinInput
          id="owner-gate-pin"
          label="Owner PIN"
          bind:value={pin}
          focusOnMount
          invalid={denied}
          onvalue={() => (denied = false)}
          oncomplete={() => void establishOwner()}
        />
      {/if}
      {#if denied}<p class="denied" role="alert">That PIN didn’t match.</p>{/if}
      {#if failed}<p class="denied" role="alert">Owner couldn’t be opened. Try again.</p>{/if}
      <div class="actions">
        <Button
          type="submit"
          variant="primary"
          label={establishing ? 'Opening…' : 'Use Owner'}
          disabled={establishing || !pinReady}
          busy={establishing}
        />
      </div>
    </form>
  {/if}
</section>

<style>
  .owner-gate {
    /* The parser-time billboard is a positioned layer. Keep this access card above it while the app is
       establishing a profile; otherwise WebKit paints the card beneath the retained artwork and leaves only
       its native form controls visible. */
    position: relative;
    z-index: 1;
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

  .actions {
    justify-self: end;
  }

  .denied {
    color: var(--bad, #ff9a9a);
  }
</style>
