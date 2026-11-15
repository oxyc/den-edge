<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { i18n } from '../lib/i18n.svelte';
  import type { ProfileChoice, ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';
  import PinInput from './PinInput.svelte';

  let {
    profiles,
    oncreated,
    onclose,
    onbusy,
  }: {
    profiles: ProfileModeCoordinator;
    oncreated: (choice: ProfileChoice) => void;
    onclose: () => void;
    onbusy: (busy: boolean) => void;
  } = $props();

  let phase = $state<'checking' | 'ready' | 'blocked'>('checking');
  let name = $state('');
  let maximumAge = $state(12);
  let pin = $state('');
  let denied = $state(false);
  let failed = $state(false);
  let creating = $state(false);
  let operationId = $state<string | null>(null);
  let attempt = 0;

  const validName = $derived(!!name.trim() && [...name.trim()].length <= 64);
  const validAge = $derived(Number.isInteger(maximumAge) && maximumAge >= 0 && maximumAge <= 18);

  onMount(() => {
    void recover();
    return () => {
      attempt++;
      onbusy(false);
    };
  });

  async function recover() {
    const current = ++attempt;
    phase = 'checking';
    failed = false;
    onbusy(true);
    const result = await profiles.resumeKidProfileCreation();
    if (current !== attempt) return;
    onbusy(false);
    if (result.outcome === 'created') return oncreated(result.choice);
    if (result.outcome === 'idle') {
      phase = 'ready';
      await tick();
      document.querySelector<HTMLInputElement>('#kid-name')?.focus({ preventScroll: true });
      return;
    }
    if (result.outcome === 'superseded' || result.outcome === 'denied') return onclose();
    phase = 'blocked';
  }

  async function create() {
    const submittedName = name.trim();
    if (phase !== 'ready' || creating || !validName || !validAge || !/^\d{4}$/.test(pin)) return;
    const submittedPin = pin;
    pin = '';
    const id = (operationId ??= crypto.randomUUID());
    const current = ++attempt;
    creating = true;
    denied = false;
    failed = false;
    onbusy(true);
    const result = await profiles.createKidProfile(submittedName, maximumAge, submittedPin, id);
    if (current !== attempt) return;
    creating = false;
    onbusy(false);
    if (result.outcome === 'created') return oncreated(result.choice);
    if (result.outcome === 'superseded') return onclose();
    if (result.outcome === 'denied') {
      // An unauthorized task result is terminal for that operation id. A later PIN proof is a new attempt;
      // only ambiguous/transient failures may replay the exact durable operation.
      operationId = null;
      denied = true;
    } else failed = true;
    await tick();
    document.querySelector<HTMLInputElement>('#kid-pin')?.focus({ preventScroll: true });
  }
</script>

<button class="back" type="button" disabled={creating} onclick={onclose}
  >← {i18n.text('profile.backToProfiles')}</button
>
<h2 id="add-kid-title">{i18n.text('profile.addKidTitle')}</h2>

{#if phase === 'checking'}
  <p role="status">{i18n.text('profile.checkingKidCreation')}</p>
{:else if phase === 'blocked'}
  <p class="denied" role="alert">{i18n.text('profile.kidCreationRecovery')}</p>
  <div class="actions">
    <button class="primary" type="button" onclick={() => void recover()}
      >{i18n.text('profile.retryKidCreation')}</button
    >
    <button type="button" onclick={onclose}>{i18n.text('common.cancel')}</button>
  </div>
{:else}
  {#if failed}<p class="denied" role="alert">{i18n.text('profile.createKidFailed')}</p>{/if}
  {#if denied}<p class="denied" role="alert">{i18n.text('profile.pinMismatch')}</p>{/if}
  <label for="kid-name">{i18n.text('profile.kidName')}</label>
  <input
    id="kid-name"
    type="text"
    autocomplete="off"
    disabled={creating || operationId !== null}
    bind:value={name}
  />
  <label for="kid-age">{i18n.text('profile.maximumAge')}</label>
  <input
    id="kid-age"
    type="number"
    min="0"
    max="18"
    inputmode="numeric"
    disabled={creating || operationId !== null}
    bind:value={maximumAge}
  />
  <PinInput
    id="kid-pin"
    label={i18n.text('profile.ownerPin')}
    bind:value={pin}
    invalid={denied}
    engaged={!creating}
    onvalue={() => {
      denied = false;
      failed = false;
    }}
    oncomplete={() => void create()}
  />
  {#if operationId !== null && failed}
    <p>{i18n.text('profile.retrySameKid')}</p>
  {/if}
  {#if creating}<p role="status">{i18n.text('profile.creatingKid')}</p>{/if}
  <div class="actions">
    <button
      class="primary"
      type="button"
      disabled={creating || !validName || !validAge || !/^\d{4}$/.test(pin)}
      onclick={() => void create()}>{i18n.text('profile.createKid')}</button
    >
    <button type="button" disabled={creating} onclick={onclose}>{i18n.text('common.cancel')}</button
    >
  </div>
{/if}

<style>
  h2,
  p {
    margin: 0;
  }

  label {
    color: var(--muted);
    font-size: 13px;
    font-weight: 650;
  }

  input {
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--field, rgb(255 255 255 / 0.045));
    color: var(--fg);
    font: inherit;
  }

  .back {
    justify-self: start;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
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
  }
</style>
