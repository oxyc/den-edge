<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import Loading from './components/Loading.svelte';
  import { LibrarySession } from './lib/librarySession.svelte';
  import { links, type Link } from './lib/links.svelte';
  import { localLibraryKey } from './lib/localLibrary';
  import type { Explore, PeopleView, Route } from './lib/route';
  import { LinkScreen, SettingsScreen } from './lib/screens.svelte';
  let {
    link,
    query,
    explore,
    people,
    onchange,
  }: {
    link: Link | null;
    query: string;
    explore: Explore;
    people: PeopleView;
    onchange: (route: Route) => void;
  } = $props();
  // With no TV, the browser's own library: the whole app, kept here, until a TV is linked.
  const ownKey = untrack(() => (link ? null : localLibraryKey()));
  const session = untrack(
    () => new LibrarySession(link?.libraryKey ?? ownKey, !link && ownKey !== null),
  );
  onMount(() =>
    session.start(() => {
      if (link) links.forgetMoved(link);
    }),
  );
</script>

<Router
  onchange={(route) => {
    // With no library at all — a browser that keeps nothing — there are no keys or plugins to show, so Settings is
    // where pairing lives. A browser with its own library has every setting, pairing among them.
    if (route.page === 'settings')
      void (link || session.local ? SettingsScreen.load() : LinkScreen.load());
    onchange(route);
  }}
>
  {#snippet children(route, active)}
    {#if route.page === 'settings'}
      {#if link || session.local}
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
      <Library {link} {session} {route} {active} {query} {explore} {people} />
    {/if}
  {/snippet}
</Router>
