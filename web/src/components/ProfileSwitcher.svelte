<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { flushSync, onMount, tick } from 'svelte';
  import type { ProfileChoice, ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';
  import { onProfileSwitcherRequest } from '../lib/profileSwitcherControl';
  import { navigate } from '../lib/navigation';
  import PinInput from './PinInput.svelte';
  import ProfileAvatar from './ProfileAvatar.svelte';

  let {
    profiles,
    hideOnMobile = false,
  }: { profiles: ProfileModeCoordinator; hideOnMobile?: boolean } = $props();
  let dialog = $state<HTMLDialogElement>();
  let trigger = $state<HTMLButtonElement>();
  let pin = $state('');
  let denied = $state(false);
  let failed = $state(false);
  let switching = $state(false);
  let pending = $state<ProfileChoice | null>(null);
  // The first switch to Kid with no Owner PIN yet sets one: entered, then entered again.
  let settingPin = $state(false);
  let firstPin = $state<string | null>(null);
  let mismatch = $state(false);
  let restoreTriggerFocus = false;
  let backdropPress = false;
  let returnFocus = $state<HTMLElement>();
  let successPath: string | undefined;
  let successRole: ProfileChoice['role'] | undefined;
  // Only receipt-incapable artifacts request an authorized Owner continuation. The E2E build keeps that exact path
  // injectable so the browser suite can cover it without duplicating the much heavier Tizen 3 build transform.
  const ownerContinuationEnabled = !__DEN_MANAGED_PLAYBACK_RECEIPTS__ || import.meta.env.DEN_E2E;

  const active = $derived(profiles.activeChoice);
  const pinConfigured = $derived(profiles.parentalPinConfigured);
  const switchLabel = $derived(
    i18n.format('actions.switchProfileCurrent', 'Switch profile, current {value}', {
      value: active?.name ?? i18n.phrase('profile'),
    }),
  );
  const pendingLabel = $derived(
    pending ? i18n.format('actions.use', 'Use {value}', { value: pending.name }) : '',
  );

  function focusPinAfterPaint() {
    requestAnimationFrame(() =>
      dialog?.querySelector<HTMLInputElement>('#owner-pin')?.focus({ preventScroll: true }),
    );
  }

  function show(opener: HTMLElement, restoreFocus: boolean, target?: ProfileChoice, path?: string) {
    denied = false;
    failed = false;
    pin = '';
    pending = null;
    settingPin = false;
    firstPin = null;
    mismatch = false;
    returnFocus = opener;
    restoreTriggerFocus = restoreFocus;
    // A continuation belongs to the requested profile, not to the dialog. If the viewer backs out and chooses a
    // different profile, that successful switch must not inherit the requested Owner's privileged destination.
    successPath = ownerContinuationEnabled && target ? path : undefined;
    successRole = ownerContinuationEnabled ? target?.role : undefined;
    dialog?.showModal();
    if (ownerContinuationEnabled && target) void choose(target);
  }

  function open(event: MouseEvent) {
    show(event.currentTarget as HTMLElement, event.detail === 0);
  }

  function backToProfiles() {
    pending = null;
    settingPin = false;
    firstPin = null;
    pin = '';
    successPath = undefined;
    successRole = undefined;
  }

  onMount(() =>
    onProfileSwitcherRequest(({ trigger: opener, restoreFocus, target, successPath: path }) =>
      show(
        opener,
        restoreFocus,
        ownerContinuationEnabled && target
          ? profiles.choices.find((choice) => choice.role === target)
          : undefined,
        path,
      ),
    ),
  );

  const choiceKey = (choice: ProfileChoice | null) =>
    choice?.role === 'visitor' ? 'visitor' : choice?.id;

  async function switchTo(choice: ProfileChoice) {
    if (switching) return;
    switching = true;
    denied = false;
    failed = false;
    // Only a switch that asked for the PIN is refused for it; any other refusal is a switch that failed.
    const askedPin = profiles.requiresPin(choice.role);
    try {
      const result =
        choice.role === 'owner'
          ? await profiles.switchToOwner(pin)
          : choice.role === 'kid' && choice.id
            ? await profiles.switchToPersistent(choice.id, pin)
            : await profiles.switchToVisitor(pin);
      if (result.outcome === 'success') {
        const path =
          ownerContinuationEnabled && choice.role === successRole ? successPath : undefined;
        successPath = undefined;
        successRole = undefined;
        dialog?.close();
        if (path) navigate(path);
        return;
      }
      if (result.outcome === 'denied' && askedPin) denied = true;
      else if (result.outcome === 'failed') {
        console.error(`den: the switch to ${choice.name} failed`, result.cause);
        failed = true;
      } else if (result.outcome === 'denied') {
        console.error(`den: the switch to ${choice.name} was refused`);
        failed = true;
      }
    } finally {
      switching = false;
      pin = '';
    }
    await tick();
    focusPinAfterPaint();
  }

  async function setPin(value: string) {
    if (!pending || switching || !/^\d{4}$/.test(value)) return;
    if (firstPin === null) {
      firstPin = value;
      pin = '';
      await tick();
      focusPinAfterPaint();
      return;
    }
    if (value !== firstPin) {
      mismatch = true;
      firstPin = null;
      pin = '';
      await tick();
      focusPinAfterPaint();
      return;
    }
    switching = true;
    failed = false;
    let saved: boolean;
    try {
      saved = await profiles.setOwnerPin(value);
    } catch (error) {
      console.error('den: the Owner PIN could not be saved', error);
      saved = false;
    } finally {
      switching = false;
      pin = '';
      firstPin = null;
    }
    if (!saved) {
      failed = true;
      await tick();
      focusPinAfterPaint();
      return;
    }
    settingPin = false;
    await switchTo(pending);
  }

  async function choose(choice: ProfileChoice) {
    denied = false;
    failed = false;
    if (choiceKey(choice) === choiceKey(active)) {
      const path =
        ownerContinuationEnabled && choice.role === successRole ? successPath : undefined;
      successPath = undefined;
      successRole = undefined;
      dialog?.close();
      if (path) navigate(path);
      return;
    }
    if (profiles.waitsForPin(choice.role)) return;
    if (profiles.setsPin(choice.role)) {
      flushSync(() => {
        pending = choice;
        settingPin = true;
        firstPin = null;
        mismatch = false;
        pin = '';
      });
      dialog?.querySelector<HTMLInputElement>('#owner-pin')?.focus({ preventScroll: true });
      return;
    }
    if (!profiles.requiresPin(choice.role) || profiles.parentalPinConfigured === false)
      return switchTo(choice);
    // iOS opens its numeric keyboard only while this original tap still owns user activation. Render the PIN
    // synchronously, then focus it before returning from the choice's click handler.
    flushSync(() => (pending = choice));
    dialog?.querySelector<HTMLInputElement>('#owner-pin')?.focus({ preventScroll: true });
  }
</script>

<button
  bind:this={trigger}
  class="profile-trigger"
  class:mobile-hidden={hideOnMobile}
  type="button"
  aria-haspopup="dialog"
  aria-label={switchLabel}
  title={switchLabel}
  onclick={open}
>
  <ProfileAvatar choice={active} compact neutral />
</button>

<dialog
  bind:this={dialog}
  aria-labelledby="profile-switcher-title"
  oncancel={(event) => {
    if (switching) event.preventDefault();
  }}
  onpointerdown={(event) => (backdropPress = event.target === dialog)}
  onpointercancel={() => (backdropPress = false)}
  onclick={(event) => {
    if (!switching && backdropPress && event.target === dialog) {
      restoreTriggerFocus = false;
      dialog?.close();
    }
    backdropPress = false;
  }}
  onclose={() => {
    denied = false;
    failed = false;
    pending = null;
    settingPin = false;
    firstPin = null;
    mismatch = false;
    successPath = undefined;
    successRole = undefined;
    requestAnimationFrame(() => {
      if (restoreTriggerFocus) returnFocus?.focus({ preventScroll: true });
      else {
        returnFocus?.blur();
        trigger?.blur();
      }
    });
  }}
>
  <form
    method="dialog"
    onsubmit={(event) => {
      event.preventDefault();
      if (pending && /^\d{4}$/.test(pin)) void (settingPin ? setPin(pin) : switchTo(pending));
    }}
  >
    <h2 id="profile-switcher-title">Who’s watching?</h2>
    {#if failed}<p class="denied" role="alert">
        The profile switch couldn’t be completed. Try again.
      </p>{/if}
    {#if pending}
      <button class="back" type="button" disabled={switching} onclick={backToProfiles}
        >← Profiles</button
      >
      <div class="pending-profile">
        <ProfileAvatar choice={pending} />
        {#if settingPin}
          <div>
            <strong>{firstPin === null ? 'Set an Owner PIN' : 'Enter the PIN again'}</strong>
            <span>Needed to switch from {pending.name} back to the Owner</span>
          </div>
        {:else}
          <div><strong>{pending.name}</strong><span>Owner approval required</span></div>
        {/if}
      </div>
      {#if settingPin}
        {#key firstPin === null}
          <PinInput
            id="owner-pin"
            label={firstPin === null ? 'New Owner PIN' : 'Confirm Owner PIN'}
            bind:value={pin}
            autocomplete="new-password"
            invalid={mismatch}
            engaged={!switching}
            onvalue={() => (mismatch = false)}
            oncomplete={(value) => void setPin(value)}
          />
        {/key}
        {#if mismatch}<p class="denied" role="alert">
            Those PINs didn’t match. Choose one again.
          </p>{/if}
      {:else if pinConfigured === undefined}
        <p role="status">Checking parental controls…</p>
      {:else if pinConfigured}
        <PinInput
          id="owner-pin"
          label="Owner PIN"
          bind:value={pin}
          invalid={denied}
          onvalue={() => (denied = false)}
          oncomplete={() => pending && void switchTo(pending)}
        />
        {#if profiles.preview}<p class="preview-pin">Preview PIN: <strong>1234</strong></p>{/if}
        {#if denied}<p class="denied" role="alert">That PIN didn’t match.</p>{/if}
      {/if}
      <div class="actions">
        {#if settingPin}
          <button
            class="primary"
            type="button"
            disabled={switching || !/^\d{4}$/.test(pin)}
            onclick={() => void setPin(pin)}
            >{switching ? 'Saving…' : firstPin === null ? 'Continue' : pendingLabel}</button
          >
        {:else}
          <button
            class="primary"
            type="button"
            disabled={pinConfigured === undefined ||
              switching ||
              (pinConfigured === true && !/^\d{4}$/.test(pin))}
            onclick={() => void switchTo(pending!)}
            >{switching ? 'Switching…' : pendingLabel}</button
          >
        {/if}
        <button type="button" disabled={switching} onclick={() => dialog?.close()}>Cancel</button>
      </div>
    {:else}
      <p class="intro">Choose once. Den opens here next time until you switch again.</p>
      <div class="profiles" aria-label="Profiles" data-spatial-list="vertical">
        {#each profiles.choices as choice (choice.role === 'visitor' ? 'visitor' : choice.id)}
          <div data-spatial-item>
            <button
              class="profile-choice"
              class:current={choiceKey(choice) === choiceKey(active)}
              type="button"
              disabled={switching || profiles.waitsForPin(choice.role)}
              aria-label={i18n.format('actions.use', 'Use {value}', { value: choice.name })}
              data-spatial-anchor
              onclick={() => void choose(choice)}
            >
              <ProfileAvatar {choice} />
              <span class="choice-copy">
                <strong>{choice.name}</strong>
                <small>
                  {choice.role === 'kid'
                    ? profiles.preview
                      ? 'Profile preview · content filtering is not active yet'
                      : `${choice.policy?.maximumAge ?? 12} and under · unrated hidden`
                    : choice.role === 'visitor'
                      ? 'Stays on this browser · activity erased when you switch profiles'
                      : 'Your library and household settings'}
                </small>
              </span>
              {#if choiceKey(choice) === choiceKey(active)}<span class="current-label">Current</span
                >{/if}
            </button>
          </div>
        {/each}
      </div>
      <div class="actions">
        <button type="button" disabled={switching} onclick={() => dialog?.close()}>Done</button>
      </div>
    {/if}
  </form>
</dialog>

<style>
  .profile-trigger {
    position: relative;
    display: grid;
    overflow: hidden;
    flex-shrink: 0;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: opacity 120ms ease;
  }

  .profile-trigger:hover {
    opacity: 0.78;

    --den-occupant-transform: translate(0, -0.4px) rotate(0deg);
  }

  .profile-trigger:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 2px;

    --den-occupant-transform: translate(0, -0.4px) rotate(0deg);
  }

  dialog {
    width: min(440px, calc(100vw - 32px));
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

  p {
    color: var(--muted);
  }

  .intro {
    font-size: 14px;
  }

  .profiles {
    display: grid;
    gap: 8px;
  }

  .profile-choice {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 64px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 13px;
    background: rgb(255 255 255 / 0.035);
    color: var(--fg);
    text-align: left;
    cursor: pointer;
  }

  .profile-choice:hover,
  .profile-choice:focus-visible {
    border-color: var(--accent-line-70);
    background: rgb(255 255 255 / 0.075);
  }

  .profile-choice.current {
    border-color: var(--accent-line-45);
  }

  .choice-copy,
  .pending-profile div {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .choice-copy small,
  .pending-profile span {
    color: var(--muted);
    font-size: 12px;
  }

  .current-label {
    margin-left: auto;
    color: var(--accent);
    font-size: 12px;
    font-weight: 650;
  }

  .pending-profile {
    display: flex;
    align-items: center;
    gap: 12px;
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

  .preview-pin {
    font-size: 12px;
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

  @media (width <= 759px) {
    .profile-trigger.mobile-hidden {
      display: none;
    }
  }
</style>
