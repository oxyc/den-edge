<script lang="ts">
  import NavigationBar from './components/NavigationBar.svelte';
  import RoutedLibrary from './RoutedLibrary.svelte';
  import { links } from './lib/links.svelte';
  import { parseRoute } from './lib/route';
  import { LinkScreen } from './lib/screens.svelte';
  import { preloadSyncPolicy } from './lib/syncLoader';

  $effect(() => {
    if (links.current) preloadSyncPolicy();
    // Pairing, and the curve it runs on, load only for a browser that isn't paired yet and hasn't already
    // chosen to look around without it.
    else if (!links.browsing) void LinkScreen.load();
  });

  // The links hold this browser's keys, and Safari clears a site's storage after a week unused unless it is
  // installed or the storage is persistent — which would mean pairing again.
  $effect(() => {
    if (links.list.length) void navigator.storage?.persist?.().catch(() => false);
  });

  let route = $state(parseRoute(location.hash));
  let query = $state('');
  const searchLibrary = $derived(links.current?.libraryKey);
  $effect(() => {
    void searchLibrary;
    query = '';
  });
</script>

<svelte:head>
  {#if links.current}
    <link rel="preconnect" href="https://api.themoviedb.org" crossorigin="anonymous" />
    <link rel="preconnect" href="https://image.tmdb.org" />
  {/if}
</svelte:head>

<NavigationBar {route} paired={!!links.current} bind:query />

<main>
  {#if links.current}
    {#key `${links.current.inboxKey}:${links.current.libraryKey}`}
      <RoutedLibrary link={links.current} {query} onchange={(next) => (route = next)} />
    {/key}
  {:else if links.browsing}
    <!-- The guest: the same app, with no library behind it. Not a second tree — `link: null` is the
         absent case the components already model. -->
    <RoutedLibrary link={null} {query} onchange={(next) => (route = next)} />
  {:else if LinkScreen.current}
    <LinkScreen.current />
  {/if}
</main>

<style>
  /* The page's column. It does NOT clip: clipping here cut the billboard and the detail trailer off at this
     column on any screen wider than it, and `overflow-clip-margin` did not save them — so the guard against
     sideways scrolling lives on `body`, where the clip box is the window itself (`app.css`). */
  main {
    max-width: var(--page-max);
    margin: 0 auto;
    padding: var(--bar-space) var(--gutter) calc(32px + env(safe-area-inset-bottom));
  }
</style>
