<script lang="ts">
  import NavigationBar from './components/NavigationBar.svelte';
  import RoutedLibrary from './RoutedLibrary.svelte';
  import { links } from './lib/links.svelte';
  import { parseRoute } from './lib/route';
  import LinkTV from './LinkTV.svelte';

  // The links hold this browser's keys, and Safari clears a site's storage after a week unused unless it is
  // installed or the storage is persistent — which would mean pairing again.
  $effect(() => {
    if (links.list.length) void navigator.storage?.persist?.().catch(() => false);
  });

  let route = $state(parseRoute(location.hash));
</script>

<NavigationBar {route} paired={!!links.current} />

<main>
  {#if links.current}
    {#key `${links.current.inboxKey}:${links.current.libraryKey}`}
      <RoutedLibrary link={links.current} onchange={(next) => (route = next)} />
    {/key}
  {:else}
    <LinkTV />
  {/if}
</main>

<style>
  main {
    max-width: 1400px;
    margin: 0 auto;
    /* Clip, not hidden: a full-bleed child is exactly as wide as the window, and a scrollbar would otherwise
       make that an overflow. Clip leaves the page's own scrolling alone. */
    overflow-x: clip;
    padding: var(--bar-space) var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }
</style>
