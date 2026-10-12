<script lang="ts">
  import { tick } from 'svelte';
  import type { ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';

  let { profiles }: { profiles: ProfileModeCoordinator } = $props();
  let dialog = $state<HTMLDialogElement>();
  let pin = $state('');
  let denied = $state(false);
  let failed = $state(false);
  let switching = $state(false);

  async function open() {
    denied = false;
    failed = false;
    pin = '';
    dialog?.showModal();
    await tick();
    if (profiles.mode === 'visitor' && profiles.parentalPinConfigured)
      dialog?.querySelector<HTMLInputElement>('input')?.focus();
  }

  async function useVisitor() {
    if (switching) return;
    switching = true;
    failed = false;
    try {
      if (await profiles.switchToVisitor()) dialog?.close();
      else failed = true;
    } catch {
      failed = true;
    } finally {
      switching = false;
    }
  }

  async function useOwner() {
    if (switching) return;
    switching = true;
    denied = false;
    failed = false;
    try {
      const switched = await profiles.switchToOwner(pin);
      if (switched) dialog?.close();
      else denied = true;
    } catch {
      failed = true;
    } finally {
      switching = false;
      pin = '';
    }
  }
</script>

<button
  class="profile-trigger"
  type="button"
  aria-haspopup="dialog"
  aria-label={`Switch profile, current ${profiles.mode === 'owner' ? 'Owner' : 'Visitor'}`}
  onclick={open}
>
  {profiles.mode === 'owner' ? 'Owner' : 'Visitor'}
</button>

<dialog
  bind:this={dialog}
  aria-labelledby="profile-switcher-title"
  onclose={() => {
    denied = false;
    failed = false;
  }}
>
  <form method="dialog" onsubmit={(event) => event.preventDefault()}>
    <h2 id="profile-switcher-title">Who’s watching?</h2>
    {#if failed}<p class="denied" role="alert">
        The profile switch couldn’t be completed. Try again.
      </p>{/if}
    {#if profiles.mode === 'owner'}
      <p>Visitor keeps activity only in this browser and won’t change the household library.</p>
      <div class="actions">
        <button class="primary" type="button" disabled={switching} onclick={() => void useVisitor()}
          >{switching ? 'Switching…' : 'Use Visitor'}</button
        >
        <button type="button" onclick={() => dialog?.close()}>Cancel</button>
      </div>
    {:else}
      <p>Switch to Owner to manage the household and use its library.</p>
      {#if profiles.parentalPinConfigured === undefined}
        <p role="status">Checking parental controls…</p>
      {:else if profiles.parentalPinConfigured}
        <label>
          Owner PIN
          <input
            bind:value={pin}
            inputmode="numeric"
            autocomplete="off"
            maxlength="4"
            pattern="[0-9]{4}"
            aria-invalid={denied}
            oninput={() => (denied = false)}
          />
        </label>
        {#if denied}<p class="denied" role="alert">That PIN didn’t match.</p>{/if}
      {/if}
      <div class="actions">
        <button
          class="primary"
          type="button"
          disabled={profiles.parentalPinConfigured === undefined ||
            switching ||
            (profiles.parentalPinConfigured === true && !/^\d{4}$/.test(pin))}
          onclick={() => void useOwner()}>{switching ? 'Switching…' : 'Use Owner'}</button
        >
        <button type="button" onclick={() => dialog?.close()}>Cancel</button>
      </div>
    {/if}
  </form>
</dialog>

<style>
  .profile-trigger {
    flex-shrink: 0;
    min-height: 32px;
    padding: 0 11px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
    cursor: pointer;
  }

  dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--bg);
    color: var(--fg);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 0.72);
    backdrop-filter: blur(5px);
  }

  form {
    display: grid;
    gap: 16px;
    padding: 24px;
  }

  h2,
  p {
    margin: 0;
  }

  p,
  label {
    color: var(--muted);
  }

  label {
    display: grid;
    gap: 8px;
  }

  input {
    width: 8ch;
    padding: 9px 11px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
    font: inherit;
    letter-spacing: 0.2em;
  }

  .denied {
    color: var(--bad, #ff9a9a);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .actions button {
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }

  .actions .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-contrast, #fff);
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
