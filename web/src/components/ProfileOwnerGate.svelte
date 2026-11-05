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
  let controls = $derived(profiles.parentalControls);
  let pinReady = $derived(
    controls.kind === 'ready' && (!controls.configured || /^\d{4}$/.test(pin)),
  );
  let retryRequested = false;

  function focusGateAction() {
    requestAnimationFrame(() =>
      gate?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true }),
    );
  }

  function retryParentalControls() {
    if (!profiles.retryParentalControls()) return;
    retryRequested = true;
  }

  $effect(() => {
    const state = controls.kind;
    if (!retryRequested || state === 'loading') return;
    retryRequested = false;
    void tick().then(focusGateAction);
  });

  async function establishOwner() {
    if (establishing) return;
    establishing = true;
    denied = false;
    failed = false;
    try {
      const result = await profiles.switchToOwner(pin);
      if (result.outcome === 'denied') denied = true;
      else if (result.outcome === 'failed') {
        console.error('den: Owner could not be opened', result.cause);
        failed = true;
      }
    } finally {
      establishing = false;
      pin = '';
    }
    await tick();
    focusGateAction();
  }
</script>

<section bind:this={gate} class="owner-gate" aria-labelledby="owner-gate-title">
  {#if controls.kind === 'loading'}
    <h1 id="owner-gate-title">Opening profiles…</h1>
    <p role="status">Checking parental controls…</p>
  {:else if controls.kind === 'failed'}
    <h1 id="owner-gate-title">Owner access</h1>
    <p role="alert">Owner couldn’t be opened. Try again.</p>
    <Button variant="primary" label="Try again" onclick={retryParentalControls} />
  {:else}
    <h1 id="owner-gate-title">Owner access</h1>
    <p>
      {controls.configured ? 'Enter the Owner PIN to continue.' : 'Continue to the Owner profile.'}
    </p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (pinReady) void establishOwner();
      }}
    >
      {#if controls.configured}
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
      <Button
        type="submit"
        variant="primary"
        label={establishing ? 'Opening…' : 'Use Owner'}
        disabled={establishing || !pinReady}
        busy={establishing}
      />
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

  .denied {
    color: var(--bad, #ff9a9a);
  }
</style>
