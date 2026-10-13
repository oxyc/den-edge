<!-- Personal settings for Kid and Visitor. No household writer is reachable here. -->
<script lang="ts">
  import AboutSection from './settings/AboutSection.svelte';
  import ContentSection from './settings/ContentSection.svelte';
  import PlaybackSection from './settings/PlaybackSection.svelte';
  import SettingsNav from './settings/SettingsNav.svelte';
  import { ATLAS_FALLBACK } from './settings/credits';
  import type { ProfileSession } from './lib/profileSession.svelte';
  import type { ProfilePreferences } from './lib/profilePreferences.svelte';

  let { session }: { session: ProfileSession } = $props();
  const prefs = $derived((session.preferences as ProfilePreferences).value);
  let saving = $state(false);
  let failure = $state<string | null>(null);
  const role = $derived(session.identity.kind === 'visitor' ? 'Visitor' : 'Kid');

  function save(changes: Parameters<ProfilePreferences['patch']>[0]) {
    saving = true;
    failure = null;
    void (session.preferences as ProfilePreferences)
      .patch(changes)
      .catch((error: unknown) => {
        console.warn('den: profile preference save failed', error);
        failure = 'Couldn’t save that. Try again.';
      })
      .finally(() => (saving = false));
  }
</script>

<div class="settings profile-settings">
  <SettingsNav variant="rail" sections={['playback', 'content', 'about']} />
  <div class="page">
    <div class="title">
      <div>
        <h1>Settings</h1>
        <p>{role} profile</p>
      </div>
    </div>
    <SettingsNav variant="bar" sections={['playback', 'content', 'about']} />
    {#if failure}<p class="banner bad" role="alert">{failure}</p>{/if}
    {#if !prefs}
      <p class="banner" role="status">Loading your settings…</p>
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
      />
    {/if}
    <AboutSection credits={[...ATLAS_FALLBACK]} />
  </div>
</div>

<style>
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
