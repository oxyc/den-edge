<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import Loading from './components/Loading.svelte';
  import { LibrarySession } from './lib/librarySession.svelte';
  import { links, type Link } from './lib/links.svelte';
  import type { Route } from './lib/route';
  import { preloadScreens, SettingsScreen } from './lib/screens.svelte';
  let { link, query, onchange }: { link: Link; query: string; onchange: (route: Route) => void } =
    $props();
  const session = untrack(() => new LibrarySession(link.libraryKey));
  onMount(() => session.start(() => links.forgetMoved(link)));
  onMount(preloadScreens);
</script>

<Router
  onchange={(route) => {
    if (route.page === 'settings') void SettingsScreen.load();
    onchange(route);
  }}
>
  {#snippet children(route, active)}
    {#if route.page === 'settings' && !SettingsScreen.current}
      <Loading label="Loading" page />
    {:else if route.page === 'settings'}
      <SettingsScreen.current {link} {session} />
    {:else}
      <Library {link} {session} {route} {active} {query} />
    {/if}
  {/snippet}
</Router>
