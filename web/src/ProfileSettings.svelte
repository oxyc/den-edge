<!--
  A profile's own settings, services and region included. No household writer is reachable here. A Kid's are behind
  the Owner PIN, asked once per session and again after any profile switch.
-->
<script lang="ts">
  import Button from './components/Button.svelte';
  import PinInput from './components/PinInput.svelte';
  import type { ProfileModeCoordinator } from './lib/profileModeCoordinator.svelte';
  import AboutSection from './settings/AboutSection.svelte';
  import ContentSection from './settings/ContentSection.svelte';
  import PlaybackSection from './settings/PlaybackSection.svelte';
  import SettingsNav from './settings/SettingsNav.svelte';
  import { ATLAS_FALLBACK } from './settings/credits';
  import type { ProfileSession } from './lib/profileSession.svelte';
  import type { ProfilePreferences } from './lib/profilePreferences.svelte';
  import { i18n } from './lib/i18n.svelte';

  let {
    session,
    profiles = null,
  }: { session: ProfileSession; profiles?: ProfileModeCoordinator | null } = $props();
  const prefs = $derived((session.preferences as ProfilePreferences).value);
  let saving = $state(false);
  let failure = $state<string | null>(null);
  const role = $derived(
    i18n.text(session.identity.kind === 'visitor' ? 'profile.visitor' : 'profile.kid'),
  );
  const locked = $derived(profiles?.settingsLocked ?? false);
  let pin = $state('');
  let denied = $state(false);

  async function unlock() {
    if (!profiles || !/^\d{4}$/.test(pin)) return;
    const entered = pin;
    pin = '';
    denied = !(await profiles.unlockSettings(entered));
  }

  async function changePolicy(policy: {
    maximumAge: number | null;
    unknownRatings: 'allow' | 'block';
  }): Promise<boolean> {
    saving = true;
    failure = null;
    const changed = (await profiles?.setKidPolicy(policy)) ?? false;
    if (!changed) failure = i18n.text('profile.policySaveFailed');
    saving = false;
    return changed;
  }

  function save(changes: Parameters<ProfilePreferences['patch']>[0]) {
    saving = true;
    failure = null;
    void (session.preferences as ProfilePreferences)
      .patch(changes)
      .catch((error: unknown) => {
        console.warn('den: profile preference save failed', error);
        failure = i18n.text('profile.saveFailed');
      })
      .finally(() => (saving = false));
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
        onvalue={() => (denied = false)}
        oncomplete={() => void unlock()}
      />
      {#if denied}<p class="denied" role="alert">{i18n.text('profile.pinMismatch')}</p>{/if}
      <div class="actions">
        <Button
          type="submit"
          variant="primary"
          label={i18n.text('profile.openSettings')}
          disabled={!/^\d{4}$/.test(pin)}
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
      {#if failure}<p class="banner bad" role="alert">{failure}</p>{/if}
      {#if !prefs}
        <p class="banner" role="status">{i18n.text('profile.loadingSettings')}</p>
      {:else}
        <PlaybackSection {prefs} disabled={saving} {save} />
        <ContentSection
          {prefs}
          content={session.content}
          pinConfigured={false}
          disabled={saving}
          {save}
          savePin={async () => false}
          verifyPin={async () => false}
          personalOnly
          contentPolicy={session.contentPolicy}
          role={session.identity.kind === 'visitor' ? 'visitor' : 'kid'}
          onpolicy={profiles && !profiles.preview && session.identity.kind === 'profile'
            ? changePolicy
            : undefined}
        />
      {/if}
      <AboutSection credits={[...ATLAS_FALLBACK]} />
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
