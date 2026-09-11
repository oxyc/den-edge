<script lang="ts">
  import Library from './Library.svelte';
  import { announceDevice, deviceLabel } from './lib/edge';
  import { links } from './lib/links.svelte';
  import LinkTV from './LinkTV.svelte';
  import Linked from './Linked.svelte';

  // Each linked TV names this device in its list. Told on every open rather than once: a TV build that doesn't
  // know the message drops it, and den-edge keeps only the latest one queued. A paired TV has the name from the
  // pairing, where den-edge couldn't change it, and takes only sealed messages.
  $effect(() => {
    const device = deviceLabel();
    for (const link of links.list) if (!link.linkKey) void announceDevice(link.inboxKey, device);
  });

  // The links hold this browser's keys, and Safari clears a site's storage after a week unused unless it is
  // installed or the storage is persistent — which would mean pairing again.
  $effect(() => {
    if (links.list.length) void navigator.storage?.persist?.().catch(() => false);
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
