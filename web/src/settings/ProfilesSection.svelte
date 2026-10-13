<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../components/Button.svelte';
  import PinInput from '../components/PinInput.svelte';
  import type { LibraryModel } from '../lib/libraryModel.svelte';
  import type { LibraryQueryResult } from '../lib/libraryServiceProtocol';
  import SettingRow from './SettingRow.svelte';
  import SettingsSection from './SettingsSection.svelte';

  type Status = Extract<LibraryQueryResult, { kind: 'profile-migration.status' }>;
  type Observation = Extract<LibraryQueryResult, { kind: 'profile-migration.observe' }>;

  let {
    model,
    pinConfigured,
    pinDelivery,
    disabled = false,
    savePin,
    verifyPin,
  }: {
    model: LibraryModel;
    pinConfigured: boolean;
    pinDelivery: 'synced' | 'queued' | 'local';
    disabled?: boolean;
    savePin: (pin: string) => Promise<'synced' | 'queued' | 'local'>;
    verifyPin: (pin: string) => Promise<boolean>;
  } = $props();

  let status = $state<Status | null>(null);
  let observation = $state<Observation | null>(null);
  let recoveryObservation = $state<{
    recoveryAttempt: string;
    source: { generation: number; head: string };
  } | null>(null);
  let modal = $state<'create-pin' | 'enable' | 'recover' | null>(null);
  let pinEstablished = $state(false);
  let pin = $state('');
  let denied = $state(false);
  let working = $state(false);
  let failure = $state<string | null>(null);

  const busy = $derived(working || status?.phase === 'reconciling');

  onMount(() => void refresh());

  async function refresh() {
    try {
      status = await model.profileMigrationStatus();
      failure = null;
    } catch {
      // Capability 404/off and transport failures are deliberately indistinguishable here.
      status = { kind: 'profile-migration.status', phase: 'off' };
    }
  }

  async function beginEnable() {
    if (busy || disabled) return;
    failure = null;
    if ((!pinConfigured || pinDelivery !== 'synced') && !pinEstablished) {
      modal = 'create-pin';
      pin = '';
      denied = false;
      return;
    }
    try {
      // The source shown to the PIN action is observed first. The Worker later opens only this exact source.
      observation = await model.observeProfileMigration();
      modal = 'enable';
      pin = '';
      denied = false;
    } catch {
      failure = 'Profiles can’t be prepared on this library yet.';
      await refresh();
    }
  }

  async function beginRecovery() {
    if (!status?.attempt || busy || disabled) return;
    try {
      const observed = await model.observeProfileRecovery(status.attempt);
      recoveryObservation = {
        recoveryAttempt: observed.recoveryAttempt,
        source: observed.source,
      };
      observation = null;
      modal = 'recover';
      pin = '';
      denied = false;
    } catch {
      failure = 'Profile recovery is not available yet.';
    }
  }

  async function authorize(value: string) {
    if (working || !/^\d{4}$/.test(value)) return;
    working = true;
    denied = false;
    failure = null;
    try {
      if (modal === 'create-pin') {
        // A locally accepted/queued PIN is not yet household authority. Do not observe or authorize a source until
        // this exact command is durably acknowledged by the server; a later retry is a fresh explicit interaction.
        if ((await savePin(value)) !== 'synced') {
          failure = 'Your Owner PIN is waiting to sync. Stay connected, then enter it again.';
          return;
        }
        pinEstablished = true;
        // Saving the PIN changes the authoritative household head, so the exact source must be observed after that
        // write. Keep the freshly entered value only in this call, verify the saved PIN, and authorize without a
        // second user prompt.
        observation = await model.observeProfileMigration();
        if (!(await verifyPin(value))) throw new Error('Saved PIN did not verify');
        const { result } = await model.enableProfiles(observation.attempt, observation.source);
        if (result.kind !== 'profile-migration.enable') throw new Error('Wrong migration result');
        if (result.outcome === 'source-changed') {
          finishModal();
          await refresh();
          failure = 'Your library changed during setup. Start again with a fresh PIN.';
          return;
        }
        finishModal();
        await refresh();
        return;
      }
      if (!(await verifyPin(value))) {
        denied = true;
        return;
      }
      if (modal === 'enable') {
        if (!observation) throw new Error('Source observation is absent');
        const { result } = await model.enableProfiles(observation.attempt, observation.source);
        if (result.kind !== 'profile-migration.enable') throw new Error('Wrong migration result');
        if (result.outcome === 'source-changed') {
          finishModal();
          await refresh();
          failure = 'Your library changed during setup. Start again with a fresh PIN.';
          return;
        }
      } else if (modal === 'recover') {
        if (!status?.attempt) throw new Error('Recovery attempt is absent');
        if (!recoveryObservation) throw new Error('Recovery source observation is absent');
        const { result } = await model.recoverProfileMigration(
          status.attempt,
          recoveryObservation.recoveryAttempt,
          recoveryObservation.source,
        );
        if (result.kind !== 'profile-migration.recover') throw new Error('Wrong recovery result');
        if (result.outcome === 'source-changed') {
          finishModal();
          await refresh();
          failure = 'Your library changed before recovery. Authorize recovery again.';
          return;
        }
      }
      finishModal();
      await refresh();
    } catch {
      if (pinEstablished && modal === 'create-pin') finishModal();
      failure =
        modal === 'recover'
          ? 'Recovery couldn’t continue. No changes were made.'
          : 'Profiles couldn’t be enabled. Enter your PIN and try again.';
    } finally {
      working = false;
      pin = '';
    }
  }

  async function cancel() {
    if (!status?.attempt || working) return;
    working = true;
    try {
      await model.cancelProfileMigration(status.attempt);
      await refresh();
    } catch {
      failure = 'The profile setup couldn’t be cancelled safely.';
    } finally {
      working = false;
    }
  }

  function closeModal() {
    if (working) return;
    finishModal();
  }

  function finishModal() {
    modal = null;
    observation = null;
    recoveryObservation = null;
    pin = '';
    denied = false;
  }

  const phaseLabel = $derived.by(() => {
    if (!status) return 'Checking…';
    if (status.phase === 'available') return 'Ready to enable';
    if (status.phase === 'preparing') return 'Preparing profiles…';
    if (status.phase === 'ready' || status.phase === 'reconciling') return 'Finishing safely…';
    if (status.phase === 'enabled') return 'Enabled';
    if (status.phase === 'recovery-required') return 'Recovery required';
    return 'Unavailable';
  });
</script>

<SettingsSection
  id="profiles"
  title="Profiles"
  subtitle="Separate Owner activity now; Kid and Visitor profiles come next."
>
  <SettingRow
    id="profile-migration"
    label="Profile libraries"
    detail="Creates a private activity library for Owner without pairing your devices again."
    value={phaseLabel}
  />
  {#if status?.phase === 'available'}
    <div class="actions">
      <Button
        variant="primary"
        label="Enable Profiles"
        disabled={disabled || working}
        onclick={() => void beginEnable()}
      />
    </div>
  {:else if status?.phase === 'recovery-required'}
    <div class="actions">
      <Button
        variant="primary"
        label="Recover safely"
        disabled={disabled || busy}
        onclick={() => void beginRecovery()}
      />
    </div>
  {:else if status?.phase === 'preparing'}
    <div class="actions">
      <Button
        variant="secondary"
        label="Cancel setup"
        disabled={disabled || working}
        onclick={() => void cancel()}
      />
    </div>
  {/if}
  {#if status?.phase === 'enabled'}
    <SettingRow
      id="profile-create-kid"
      label="Kid profile"
      detail="Profile creation will arrive after the directory writer is enabled."
      value="Coming next"
    />
  {/if}
  {#if failure && !modal}<p class="failure" role="alert">{failure}</p>{/if}
</SettingsSection>

{#if modal}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) closeModal();
    }}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="profiles-pin-title">
      <h2 id="profiles-pin-title">
        {modal === 'recover'
          ? 'Authorize profile recovery'
          : modal === 'enable'
            ? 'Enable Profiles'
            : pinConfigured
              ? 'Finish saving your Owner PIN'
              : 'Create your Owner PIN'}
      </h2>
      <p>
        {modal !== 'create-pin'
          ? 'Enter your Owner PIN. This authorizes this exact setup from backup through commit.'
          : pinConfigured
            ? 'Enter the same four-digit Owner PIN to finish syncing it before setup.'
            : 'Choose a four-digit Owner PIN. Den saves it and uses this entry to authorize setup.'}
      </p>
      <PinInput
        id="profiles-owner-pin"
        label="Owner PIN"
        bind:value={pin}
        focusOnMount
        autocomplete={modal === 'create-pin' ? 'new-password' : 'off'}
        invalid={denied}
        engaged={!working}
        onvalue={() => (denied = false)}
        oncomplete={(value) => void authorize(value)}
      />
      {#if denied}<p class="failure" role="alert">That PIN didn’t match.</p>{/if}
      {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
      <div class="modal-actions">
        <Button variant="tertiary" label="Cancel" disabled={working} onclick={closeModal} />
        <Button
          variant="primary"
          label={working ? 'Authorizing…' : 'Continue'}
          disabled={working || !/^\d{4}$/.test(pin)}
          onclick={() => void authorize(pin)}
        />
      </div>
    </div>
  </div>
{/if}

<style>
  .actions {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px;
    border-radius: var(--radius);
    background: var(--card);
  }

  .failure {
    margin: 8px 16px 0;
    color: var(--bad, #ff9a9a);
  }

  .modal-backdrop {
    position: fixed;
    z-index: 100;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgb(0 0 0 / 0.68);
  }

  .modal {
    display: grid;
    gap: 16px;
    width: min(100%, 440px);
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 20px;
    background: var(--card);
    box-shadow: 0 24px 80px rgb(0 0 0 / 0.45);
  }

  .modal h2,
  .modal p {
    margin: 0;
  }

  .modal > p {
    color: var(--muted);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
