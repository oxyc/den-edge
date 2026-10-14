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
  const setupInProgress =
    'Profile setup is already in progress on another device. Nothing was changed; finish it there, or use Recover safely to take it over.';
  const sourceRefused =
    'Your library needed an update before Profiles could be set up. Nothing was changed and setup was released; enable Profiles again.';
  let recoveryObservation = $state<{
    attempt: string | null;
    recoveryAttempt: string;
    source: { generation: number; head: string };
  } | null>(null);
  let modal = $state<'create-pin' | 'enable' | 'recover' | 'create-kid' | null>(null);
  let pinEstablished = $state(false);
  let pin = $state('');
  let denied = $state(false);
  let working = $state(false);
  let failure = $state<string | null>(null);
  let kidName = $state('Kids');
  let maximumAge = $state(12);
  let created = $state<string | null>(null);

  const busy = $derived(working || status?.phase === 'reconciling');
  const kidNameValid = $derived(!!kidName.trim() && [...kidName.trim()].length <= 64);

  onMount(() => void refresh());

  async function refresh() {
    try {
      status = await model.profileMigrationStatus();
      failure = null;
    } catch (error) {
      // Capability 404/off and transport failures are deliberately indistinguishable here.
      console.warn('den: profile setup status could not be read', error);
      status = { kind: 'profile-migration.status', phase: 'off' };
      return;
    }
    if (status.phase === 'enabled') {
      try {
        const resumed = await model.profileCreateStatus();
        if (resumed.phase === 'created') created = `${resumed.name} is ready.`;
      } catch (error) {
        // The household is still profile-aware. A transient Kid-journal retry must not hide profile settings.
        console.error('den: a pending Kid profile could not be resumed', error);
        failure = 'A pending Kid profile couldn’t be resumed yet. Try again when Den is online.';
      }
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
    } catch (error) {
      console.error('den: the profile setup source could not be observed', error);
      failure = 'Profiles can’t be prepared on this library yet.';
      await refresh();
    }
  }

  async function beginRecovery() {
    if (
      (status?.phase !== 'recovery-required' && status?.phase !== 'setup-in-progress') ||
      busy ||
      disabled
    )
      return;
    try {
      // A split journal on this device names its attempt; without one this is the journal-less Owner Restore.
      const observed = await model.observeProfileRecovery(status.attempt ?? null);
      recoveryObservation = {
        attempt: observed.attempt,
        recoveryAttempt: observed.recoveryAttempt,
        source: observed.source,
      };
      observation = null;
      modal = 'recover';
      pin = '';
      denied = false;
    } catch (error) {
      console.error('den: profile recovery could not be observed', error);
      failure = 'Profile recovery is not available yet.';
    }
  }

  function beginCreateKid() {
    if (busy || disabled) return;
    kidName = 'Kids';
    maximumAge = 12;
    pin = '';
    denied = false;
    failure = null;
    modal = 'create-kid';
  }

  async function createKid(value: string) {
    if (
      working ||
      !/^\d{4}$/.test(value) ||
      !kidNameValid ||
      !Number.isInteger(maximumAge) ||
      maximumAge < 0 ||
      maximumAge > 18
    )
      return;
    working = true;
    denied = false;
    failure = null;
    try {
      if (!(await verifyPin(value))) {
        denied = true;
        return;
      }
      const { result } = await model.createKidProfile(kidName.trim(), maximumAge, value);
      if (result.kind !== 'profile.create') throw new Error('Wrong profile creation result');
      created = `${result.name} is ready.`;
      finishModal();
    } catch (error) {
      console.error('den: the Kid profile could not be created', error);
      failure = 'The Kid profile couldn’t be created safely. Enter your PIN and try again.';
    } finally {
      working = false;
      pin = '';
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
        if (result.outcome === 'setup-in-progress') {
          finishModal();
          await refresh();
          failure = setupInProgress;
          return;
        }
        if (result.outcome === 'source-refused') {
          finishModal();
          await refresh();
          failure = sourceRefused;
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
        if (result.outcome === 'setup-in-progress') {
          finishModal();
          await refresh();
          failure = setupInProgress;
          return;
        }
        if (result.outcome === 'source-refused') {
          finishModal();
          await refresh();
          failure = sourceRefused;
          return;
        }
      } else if (modal === 'recover') {
        if (!recoveryObservation) throw new Error('Recovery source observation is absent');
        const { result } = await model.recoverProfileMigration(
          recoveryObservation.attempt,
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
        if (result.outcome === 'setup-in-progress') {
          finishModal();
          await refresh();
          failure = setupInProgress;
          return;
        }
      }
      finishModal();
      await refresh();
    } catch (error) {
      console.error(`den: profile ${modal === 'recover' ? 'recovery' : 'setup'} failed`, error);
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
    } catch (error) {
      console.error('den: profile setup could not be cancelled', error);
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
    if (status.phase === 'setup-in-progress') return 'Setup in progress';
    return 'Unavailable';
  });
</script>

<SettingsSection
  id="profiles"
  title="Profiles"
  subtitle="Separate Owner, Kid and Visitor activity and preferences."
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
  {:else if status?.phase === 'recovery-required' || status?.phase === 'setup-in-progress'}
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
      detail="Create a separate activity library. Unrated titles stay hidden; you choose the maximum age."
      value={created ?? 'Not created'}
    />
    <div class="actions">
      <Button
        variant="secondary"
        label="Create Kid profile"
        disabled={disabled || working}
        onclick={beginCreateKid}
      />
    </div>
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
        {modal === 'create-kid'
          ? 'Create a Kid profile'
          : modal === 'recover'
            ? 'Authorize profile recovery'
            : modal === 'enable'
              ? 'Enable Profiles'
              : pinConfigured
                ? 'Finish saving your Owner PIN'
                : 'Create your Owner PIN'}
      </h2>
      <p>
        {modal === 'create-kid'
          ? 'Choose the profile name and oldest allowed rating, then enter your Owner PIN.'
          : modal !== 'create-pin'
            ? 'Enter your Owner PIN. This authorizes this exact setup from backup through commit.'
            : pinConfigured
              ? 'Enter the same four-digit Owner PIN to finish syncing it before setup.'
              : 'Choose a four-digit Owner PIN. Den saves it and uses this entry to authorize setup.'}
      </p>
      {#if modal === 'create-kid'}
        <label class="field">
          <span>Name</span>
          <input bind:value={kidName} maxlength="128" autocomplete="off" />
        </label>
        <label class="field">
          <span>Maximum age rating</span>
          <input bind:value={maximumAge} type="number" min="0" max="18" inputmode="numeric" />
        </label>
      {/if}
      <PinInput
        id="profiles-owner-pin"
        label="Owner PIN"
        bind:value={pin}
        focusOnMount
        autocomplete={modal === 'create-pin' ? 'new-password' : 'off'}
        invalid={denied}
        engaged={!working}
        onvalue={() => (denied = false)}
        oncomplete={(value) => void (modal === 'create-kid' ? createKid(value) : authorize(value))}
      />
      {#if denied}<p class="failure" role="alert">That PIN didn’t match.</p>{/if}
      {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
      <div class="modal-actions">
        <Button variant="tertiary" label="Cancel" disabled={working} onclick={closeModal} />
        <Button
          variant="primary"
          label={working ? 'Working…' : modal === 'create-kid' ? 'Create profile' : 'Continue'}
          disabled={working ||
            !/^\d{4}$/.test(pin) ||
            (modal === 'create-kid' && (!kidNameValid || maximumAge < 0 || maximumAge > 18))}
          onclick={() => void (modal === 'create-kid' ? createKid(pin) : authorize(pin))}
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

  .field {
    display: grid;
    gap: 7px;
    color: var(--muted);
  }

  .field input {
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    color: inherit;
    background: var(--background, #111);
    font: inherit;
  }
</style>
