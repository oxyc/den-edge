<!-- den-edge holds no log for this library and won't start one (`refused-start`): edits stay on this device, and
     joining the household's library in Settings › Linked devices is the way out. Loaded only in that state. -->
<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { navigate } from '../lib/navigation';

  /**
   * `missing`: the shown session's library is refused (it stays mounted once loaded, and says nothing otherwise).
   * `route`: which Settings this profile opens; only household Settings has Linked devices.
   */
  let { missing, route }: { missing: boolean; route: string } = $props();

  // Settings and its rows load lazily, and a route page is mounted hidden (`inert`) and shown after: the row is opened
  // through its own button and focused once it is on a shown page, trying each frame for at most five seconds' worth.
  function openLinkedDevices() {
    navigate('/settings');
    let frames = 300;
    const reveal = () => {
      const row = document.querySelector<HTMLButtonElement>('#linked-devices > .row');
      if (!row || row.closest('[inert]')) return --frames && requestAnimationFrame(reveal);
      if (row.getAttribute('aria-expanded') !== 'true') row.click();
      row.focus();
    };
    requestAnimationFrame(reveal);
  }
</script>

{#if missing}<p class="library-status" role="alert">
    <span
      >{i18n.phrase(
        'This device’s library isn’t on Den. Your changes are kept here—join your household’s library in Settings › Linked devices.',
      )}</span
    >{#if route === 'household'}<button type="button" class="undo" onclick={openLinkedDevices}
        >{i18n.phrase('Open Linked devices')}</button
      >{/if}
  </p>{/if}
