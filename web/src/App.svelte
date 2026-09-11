<script lang="ts">
  import Library from './Library.svelte';
  import { announceDevice, deviceLabel } from './lib/edge';
  import { links } from './lib/links.svelte';
  import LinkTV from './LinkTV.svelte';
  import Linked from './Linked.svelte';

  // Each linked TV names this device in its list; tell it again whenever the label changes (a new browser
  // version doesn't change it, a different browser has its own links).
  $effect(() => {
    const device = deviceLabel();
    for (const link of links.list) {
      if (link.device === device) continue;
      void announceDevice(link.inboxKey, device).then((ok) => ok && links.noteDevice(link.inboxKey, device));
    }
  });
</script>

<header class="bar glass">
  <span class="brand">Den</span>
</header>

<main>
  {#if links.current}
    {#key links.current.inboxKey}
      <Library link={links.current} />
    {/key}
    <Linked link={links.current} />
  {:else}
    <LinkTV />
  {/if}
</main>

<style>
  .bar {
    position: sticky;
    top: max(12px, env(safe-area-inset-top));
    z-index: 10;
    display: flex;
    align-items: center;
    margin: 12px var(--gutter) 0;
    padding: 12px 20px;
    border-radius: 999px;
  }

  .brand {
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  main {
    max-width: 1400px;
    margin: 0 auto;
    padding: 28px var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }
</style>
