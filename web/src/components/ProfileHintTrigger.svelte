<script lang="ts">
  import type { ProfileChoice } from '../lib/profileModeCoordinator.svelte';
  import ProfileAvatar from './ProfileAvatar.svelte';
  import { i18n } from '../lib/i18n.svelte';

  /** The remembered profile, drawn in the switcher's place until the coordinator can open the real switcher. */
  let { choice }: { choice: ProfileChoice } = $props();
</script>

<button
  class="profile-trigger mobile-hidden"
  type="button"
  disabled
  aria-label={i18n.format('actions.switchProfileCurrent', 'Switch profile, current {value}', {
    value: choice.name,
  })}
  title={i18n.format('actions.switchProfileCurrent', 'Switch profile, current {value}', {
    value: choice.name,
  })}
>
  <ProfileAvatar {choice} compact neutral />
</button>

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
  }

  @media (width <= 759px) {
    .profile-trigger.mobile-hidden {
      display: none;
    }
  }
</style>
