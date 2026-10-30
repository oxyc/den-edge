<script lang="ts">
  import type { ProfileModeCoordinator } from '../lib/profileModeCoordinator.svelte';
  import { openProfileSwitcher } from '../lib/profileSwitcherControl';
  import ProfileAvatar from './ProfileAvatar.svelte';
  import { i18n } from '../lib/i18n.svelte';

  let { profiles }: { profiles: ProfileModeCoordinator } = $props();
  const active = $derived(profiles.activeChoice);
</script>

<button
  class="mobile-profile-row"
  type="button"
  aria-label={i18n.format('actions.switchProfileCurrent', 'Switch profile, current {value}', {
    value: active?.name ?? i18n.phrase('profile'),
  })}
  onclick={(event) =>
    openProfileSwitcher({ trigger: event.currentTarget, restoreFocus: event.detail === 0 })}
>
  <ProfileAvatar choice={active} />
  <span><strong>{active?.name ?? 'Profile'}</strong><small>Switch profile</small></span>
  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
</button>

<style>
  .mobile-profile-row {
    display: none;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 66px;
    margin: 0 0 18px;
    padding: 11px 14px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--card);
    color: var(--fg);
    text-align: left;
    cursor: pointer;
  }

  .mobile-profile-row span {
    display: grid;
    gap: 3px;
  }

  .mobile-profile-row small {
    color: var(--muted);
  }

  .mobile-profile-row svg {
    margin-left: auto;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.5;
  }

  .mobile-profile-row:focus-visible {
    outline: var(--ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  @media (width <= 759px) {
    .mobile-profile-row {
      display: flex;
    }
  }
</style>
