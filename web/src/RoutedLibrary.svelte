<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import Settings from './Settings.svelte';
  import { LibrarySession } from './lib/librarySession.svelte';
  import { links, type Link } from './lib/links.svelte';
  import type { Route } from './lib/route';
  let { link, onchange }: { link: Link; onchange: (route: Route) => void } = $props();
  const session = untrack(() => new LibrarySession(link.libraryKey));
  onMount(() => session.start(() => links.forgetMoved(link)));
</script>

<Router {onchange}>
  {#snippet children(route, active)}
    {#if route.page === 'settings'}
      <Settings {link} {session} />
    {:else}
      <Library {link} {session} {route} {active} />
    {/if}
  {/snippet}
</Router>
