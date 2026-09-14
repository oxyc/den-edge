<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import Loading from './components/Loading.svelte';
  import { LibrarySession } from './lib/librarySession.svelte';
  import { links, type Link } from './lib/links.svelte';
  import type { Route } from './lib/route';
  import { LinkScreen, SettingsScreen } from './lib/screens.svelte';
  let {
    link,
    query,
    onchange,
  }: { link: Link | null; query: string; onchange: (route: Route) => void } = $props();
  const session = untrack(() => new LibrarySession(link?.libraryKey ?? null));
  onMount(() =>
    session.start(() => {
      if (link) links.forgetMoved(link);
    }),
  );
</script>

<Router
  onchange={(route) => {
    // With no library there are no keys or plugins to show, so Settings is where pairing lives.
    if (route.page === 'settings') void (link ? SettingsScreen.load() : LinkScreen.load());
    onchange(route);
  }}
>
  {#snippet children(route, active)}
    {#if route.page === 'settings'}
      {#if link}
        {#if SettingsScreen.current}
          <SettingsScreen.current {link} {session} />
        {:else}
          <Loading label="Loading" page />
        {/if}
      {:else if LinkScreen.current}
        <LinkScreen.current />
      {:else}
        <Loading label="Loading" page />
      {/if}
    {:else}
      <Library {link} {session} {route} {active} {query} />
    {/if}
  {/snippet}
</Router>
