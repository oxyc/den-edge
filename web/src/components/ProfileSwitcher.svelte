<script lang="ts">
  import { flushSync, onMount, tick } from 'svelte';
  import type { ProfileChoice, ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';
  import { onProfileSwitcherRequest } from '../lib/profileSwitcherControl';
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

  const active = $derived(profiles.activeChoice);

  function focusPinAfterPaint() {
    requestAnimationFrame(() =>
      dialog?.querySelector<HTMLInputElement>('#owner-pin')?.focus({ preventScroll: true }),
    );
  }

  function show(opener: HTMLElement, restoreFocus: boolean) {
    denied = false;
    failed = false;
    pin = '';
    pending = null;
    settingPin = false;
    firstPin = null;
    mismatch = false;
    returnFocus = opener;
    restoreTriggerFocus = restoreFocus;
    dialog?.showModal();
  }

  function open(event: MouseEvent) {
    show(event.currentTarget as HTMLElement, event.detail === 0);
  }

  onMount(() =>
    onProfileSwitcherRequest(({ trigger: opener, restoreFocus }) => show(opener, restoreFocus)),
  );

  const choiceKey = (choice: ProfileChoice | null) =>
    choice?.role === 'visitor' ? 'visitor' : choice?.id;

  async function switchTo(choice: ProfileChoice) {
    if (switching) return;
    switching = true;
    denied = false;
    failed = false;
    try {
      const switched =
        choice.role === 'owner'
          ? await profiles.switchToOwner(pin)
          : choice.role === 'kid' && choice.id
            ? await profiles.switchToPersistent(choice.id, pin)
            : await profiles.switchToVisitor(pin);
      if (switched) {
        dialog?.close();
        return;
      }
      denied = true;
    } catch {
      failed = true;
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
    } catch {
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
      dialog?.close();
      return;
    }
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
  aria-label={`Switch profile, current ${active?.name ?? 'profile'}`}
  title={`Switch profile, current ${active?.name ?? 'profile'}`}
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
    {#if pending && settingPin}
      <button
        class="back"
        type="button"
        disabled={switching}
        onclick={() => ((pending = null), (settingPin = false), (firstPin = null), (pin = ''))}
        >← Profiles</button
      >
      <div class="pending-profile">
        <ProfileAvatar choice={pending} />
        <div>
          <strong>{firstPin === null ? 'Set an Owner PIN' : 'Enter the PIN again'}</strong>
          <span>Needed to switch from {pending.name} back to the Owner</span>
        </div>
      </div>
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
      <div class="actions">
        <button
          class="primary"
          type="button"
          disabled={switching || !/^\d{4}$/.test(pin)}
          onclick={() => void setPin(pin)}
          >{switching ? 'Saving…' : firstPin === null ? 'Continue' : `Use ${pending.name}`}</button
        >
        <button type="button" disabled={switching} onclick={() => dialog?.close()}>Cancel</button>
      </div>
    {:else if pending}
      <button
        class="back"
        type="button"
        disabled={switching}
        onclick={() => ((pending = null), (pin = ''))}>← Profiles</button
      >
      <div class="pending-profile">
        <ProfileAvatar choice={pending} />
        <div><strong>{pending.name}</strong><span>Owner approval required</span></div>
      </div>
      {#if profiles.parentalPinConfigured === undefined}
        <p role="status">Checking parental controls…</p>
      {:else if profiles.parentalPinConfigured}
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
        <button
          class="primary"
          type="button"
          disabled={profiles.parentalPinConfigured === undefined ||
            switching ||
            (profiles.parentalPinConfigured === true && !/^\d{4}$/.test(pin))}
          onclick={() => void switchTo(pending!)}
          >{switching ? 'Switching…' : `Use ${pending.name}`}</button
        >
        <button type="button" disabled={switching} onclick={() => dialog?.close()}>Cancel</button>
      </div>
    {:else}
      <p class="intro">Choose once. Den opens here next time until you switch again.</p>
      <div class="profiles" aria-label="Profiles">
        {#each profiles.choices as choice (choice.role === 'visitor' ? 'visitor' : choice.id)}
          <button
            class="profile-choice"
            class:current={choiceKey(choice) === choiceKey(active)}
            type="button"
            disabled={switching}
            aria-label={`Use ${choice.name}`}
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
    border-color: color-mix(in srgb, var(--accent) 70%, var(--line));
    background: rgb(255 255 255 / 0.075);
  }

  .profile-choice.current {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
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
