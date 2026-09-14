<script lang="ts">
  import NavigationBar from './components/NavigationBar.svelte';
  import RoutedLibrary from './RoutedLibrary.svelte';
  import { untrack } from 'svelte';
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

  let route = $state(parseRoute(location.pathname + location.search));
  // The address holds the search, so a result page can be linked, reloaded or shared and still be the same
  // search. It is read from there rather than derived from the current page: opening a result and coming back
  // would otherwise empty the query and fill it again, which re-runs the search and loses where it was
  // scrolled to. The field keeps what was typed until another search replaces it.
  let query = $state(untrack(() => (route.page === 'search' ? route.query : '')));
  $effect(() => {
    if (route.page === 'search') query = route.query;
  });
</script>

<svelte:head>
  {#if links.current}
    <link rel="preconnect" href="https://api.themoviedb.org" crossorigin="anonymous" />
    <link rel="preconnect" href="https://image.tmdb.org" />
  {/if}
</svelte:head>

<NavigationBar {route} paired={!!links.current} {query} />

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
