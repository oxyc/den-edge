<!--
  A profile's own settings, services and region included. No household writer is reachable here. A Kid's are behind
  the Owner PIN, asked once per session and again after any profile switch.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Button from './components/Button.svelte';
  import PinInput from './components/PinInput.svelte';
  import type { ProfileModeCoordinator } from './lib/profileModeCoordinator.svelte';
  import AboutSection from './settings/AboutSection.svelte';
  import ContentSection from './settings/ContentSection.svelte';
  import PlaybackSection from './settings/PlaybackSection.svelte';
  import SettingRow from './settings/SettingRow.svelte';
  import SettingsNav from './settings/SettingsNav.svelte';
  import SettingsSection from './settings/SettingsSection.svelte';
  import { AIRING_CREDIT, ATLAS_FALLBACK } from './settings/credits';
  import type { ProfileSession } from './lib/profileSession.svelte';
  import type { ProfilePreferences } from './lib/profilePreferences.svelte';
  import { i18n, setInterfaceLanguage } from './lib/i18n.svelte';
  import { rememberFreshPresentationLanguage } from './lib/translationCache';

  let {
    session,
    profiles = null,
  }: { session: ProfileSession; profiles?: ProfileModeCoordinator | null } = $props();
  const prefs = $derived.by(() => {
    const value = (session.preferences as ProfilePreferences).value;
    return value ? { ...value, interfaceLanguage: i18n.language } : undefined;
  });
  let saving = $state(false);
  type PreferenceChanges = Parameters<ProfilePreferences['patch']>[0];
  type PreferenceFailure =
    | ['profile.policySaveFailed']
    | ['profile.saveFailed' | 'presentation', ProfileSession, PreferenceChanges, boolean];
  let failure = $state<PreferenceFailure | null>(null);
  let preferenceGeneration = 0;
  const role = $derived(
    i18n.text(session.identity.kind === 'visitor' ? 'profile.visitor' : 'profile.kid'),
  );
  const locked = $derived(profiles?.settingsLocked ?? false);
  let pin = $state('');
  let denied = $state(false);
  let checking = $state(false);
  let verificationFailed = $state(false);
  let unlockAttempt = 0;

  $effect.pre(() => {
    if (session) {
      preferenceGeneration++;
      failure = null;
      saving = false;
    }
  });

  onDestroy(() => {
    unlockAttempt++;
    preferenceGeneration++;
  });

  async function unlock() {
    if (!profiles || checking || !/^\d{4}$/.test(pin)) return;
    const coordinator = profiles;
    const attempt = ++unlockAttempt;
    const active = session;
    const entered = pin;
    pin = '';
    denied = false;
    verificationFailed = false;
    checking = true;
    const current = () => attempt === unlockAttempt && coordinator.session === active;
    try {
      const unlocked = await coordinator.unlockSettings(entered);
      if (current()) denied = !unlocked;
    } catch (error) {
      console.warn('den:p/pin', error);
      if (current()) verificationFailed = true;
    } finally {
      if (current()) {
        checking = false;
        requestAnimationFrame(() => document.getElementById('settings-gate-pin')?.focus());
      }
    }
  }

  async function changePolicy(policy: {
    maximumAge: number | null;
    unknownRatings: 'allow' | 'block';
  }): Promise<boolean> {
    const active = session;
    const generation = ++preferenceGeneration;
    saving = true;
    failure = null;
    const changed = (await profiles?.setKidPolicy(policy)) ?? false;
    if (generation === preferenceGeneration && active === session) {
      if (!changed) failure = ['profile.policySaveFailed'];
      saving = false;
    }
    return changed;
  }

  async function savePreferences(changes: PreferenceChanges, presentationOnly = false) {
    const active = session;
    const generation = ++preferenceGeneration;
    let written = presentationOnly;
    saving = true;
    failure = null;
    try {
      if (!written) {
        await (active.preferences as ProfilePreferences).patch(changes);
        written = true;
      }
      if (generation !== preferenceGeneration || active !== session) return;
      if (changes.interfaceLanguage) {
        rememberFreshPresentationLanguage(changes.interfaceLanguage);
        active.presentIn(changes.interfaceLanguage);
        await setInterfaceLanguage(changes.interfaceLanguage);
      }
    } catch (error: unknown) {
      console.warn(written ? 'den:p/pref-present' : 'den:p/pref-save', error);
      if (generation === preferenceGeneration && active === session) {
        failure = [written ? 'presentation' : 'profile.saveFailed', active, changes, written];
      }
    } finally {
      if (generation === preferenceGeneration && active === session) saving = false;
    }
  }

  function save(changes: PreferenceChanges) {
    void savePreferences(changes);
  }

  function retryPreferences() {
    const failed = failure;
    if (failed?.length === 4 && failed[1] === session) void savePreferences(failed[2], failed[3]);
  }
</script>

{#if locked}
  <section class="settings-gate" aria-labelledby="settings-gate-title">
    <h1 id="settings-gate-title">{i18n.text('profile.ownerAccess')}</h1>
    <p>{i18n.text('profile.ownerPinPrompt')}</p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void unlock();
      }}
    >
      <PinInput
        id="settings-gate-pin"
        label={i18n.text('profile.ownerPin')}
        bind:value={pin}
        focusOnMount
        invalid={denied}
        engaged={!checking}
        disabled={checking}
        onvalue={() => {
          denied = false;
          verificationFailed = false;
        }}
        oncomplete={() => void unlock()}
      />
      {#if denied}<p class="denied" role="alert">{i18n.text('profile.pinMismatch')}</p>{/if}
      {#if verificationFailed}<p class="denied" role="alert">
          {i18n.text('profile.pinCheckFailed')}
        </p>{:else if checking}<p role="status">{i18n.text('profile.checkingOwnerPin')}</p>{/if}
      <div class="actions">
        <Button
          type="submit"
          variant="primary"
          label={checking
            ? i18n.text('profile.checkingOwnerPin')
            : i18n.text('profile.openSettings')}
          busy={checking}
          disabled={checking || !/^\d{4}$/.test(pin)}
        />
      </div>
    </form>
  </section>
{:else}
  <div class="settings profile-settings">
    <SettingsNav variant="rail" sections={['playback', 'content', 'about']} />
    <div class="page">
      <div class="title">
        <div>
          <h1>{i18n.text('settings.title')}</h1>
          <p>{role}</p>
        </div>
      </div>
      <SettingsNav variant="bar" sections={['playback', 'content', 'about']} />
      {#if failure}<div class="banner bad" role="alert">
          <span
            >{failure[0] === 'presentation'
              ? i18n.phrase('Saved, but not shown.')
              : i18n.text(failure[0])}</span
          >
          {#if failure.length > 1}<Button
              variant="secondary"
              label={i18n.phrase('Retry')}
              disabled={saving}
              onclick={retryPreferences}
            />{/if}
        </div>{/if}
      {#if !prefs}
        <p class="banner" role="status">{i18n.text('profile.loadingSettings')}</p>
      {:else}
        <PlaybackSection {prefs} disabled={saving} {save} />
        {#if __DEN_TV_LEGACY_JS_CORE__}
          <SettingsSection id="content" title={i18n.text('settings.section.content')}>
            {#if session.identity.kind === 'visitor'}
              <SettingRow
                id="visitor-content-unavailable"
                label={i18n.phrase('Visitor content preferences are unavailable on this TV')}
                detail={i18n.phrase(
                  'Visitor preferences stay on the device where that visit was created',
                )}
              >
                <p>
                  {i18n.phrase(
                    'Use this TV for playback, or end the Visitor visit and choose a household profile. Nothing is changed.',
                  )}
                </p>
              </SettingRow>
            {:else}
              <SettingRow
                id="profile-content-management-handoff"
                label={i18n.phrase('Manage profile content in a supported browser')}
                detail={i18n.phrase('Profile content administration is not available on this TV')}
              >
                <p>
                  {i18n.phrase(
                    'On a phone or computer linked to this household, switch to this profile and open Den › Settings › Content.',
                  )}
                </p>
                <p class="mono">{`${__DEN_TV_WEB_ORIGIN__ || location.origin}/settings#content`}</p>
              </SettingRow>
            {/if}
          </SettingsSection>
        {:else}
          <ContentSection
            {prefs}
            content={session.content}
            pinConfigured={false}
            disabled={saving}
            {save}
            savePin={async () => 'failed' as const}
            verifyPin={async () => false}
            personalOnly
            contentPolicy={session.contentPolicy}
            role={session.identity.kind === 'visitor' ? 'visitor' : 'kid'}
            onpolicy={profiles && !profiles.preview && session.identity.kind === 'profile'
              ? changePolicy
              : undefined}
          />
        {/if}
      {/if}
      <AboutSection credits={[...ATLAS_FALLBACK, AIRING_CREDIT]} />
    </div>
  </div>
{/if}

<style>
  .settings-gate {
    display: grid;
    gap: 12px;
    max-width: 420px;
    margin: 64px auto;
  }

  /* The switcher's PIN prompt spacing. */
  .settings-gate form {
    display: grid;
    gap: 16px;
  }

  .settings-gate .actions {
    justify-self: start;
  }

  .settings-gate .denied {
    color: var(--danger);
  }

  .settings {
    display: grid;
    grid-template-columns: 220px minmax(0, 760px);
    justify-content: center;
    gap: 56px;
  }

  .page {
    min-width: 0;
  }

  .title {
    margin: 8px 0 20px;
  }

  h1,
  p {
    margin: 0;
  }

  .title p,
  .banner {
    color: var(--muted);
  }

  h1 {
    font-size: 28px;
  }

  .banner {
    margin: 0 0 20px;
    padding: 12px 16px;
    border-radius: 12px;
    background: var(--card);
  }

  .banner.bad {
    color: var(--danger);
  }

  @media (width < 1100px) {
    .settings {
      grid-template-columns: minmax(0, 720px);
    }

    .settings > :global(.rail) {
      display: none;
    }
  }

  /* Match the shared Settings row vocabulary without making profile Settings depend on Owner-only markup. */
  .settings :global(.panel h3) {
    margin: 18px 0 8px;
    color: var(--muted);
    font-size: 14px;
    font-weight: 600;
  }

  .settings :global(.field) {
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgb(255 255 255 / 0.06);
    color: var(--fg);
    font: inherit;
  }

  .settings :global(.summary) {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin: 14px 0 4px;
    color: var(--muted);
    font-size: 14px;
  }

  .settings :global(.foot) {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .settings :global(.link-button) {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
</style>
