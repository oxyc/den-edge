<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Router from './Router.svelte';
  import Library from './Library.svelte';
  import ScreenLoading from './components/ScreenLoading.svelte';
  import { LibrarySession } from './lib/librarySession.svelte';
  import { links, type Link } from './lib/links.svelte';
  import { followLocalLibrary, localLibraryKey } from './lib/localLibrary';
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
  const open = (own: string | null) =>
    untrack(() => new LibrarySession(link?.libraryKey ?? own, !link && own !== null));
  let session = $state.raw(open(ownKey));
  $effect(() => {
    const current = session;
    return untrack(() => {
      const stop = current.start(() => {
        if (link) links.forgetMoved(link);
      });
      return () => {
        stop();
        current.services.stop();
      };
    });
  });
  // Another tab made this browser's own library at the same moment, and its key is the one kept: this tab's rows go
  // into that library, and the page goes on with it.
  onMount(() => (ownKey ? followLocalLibrary(ownKey, (key) => (session = open(key))) : undefined));
</script>

{#key session}
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
            <ScreenLoading screen={SettingsScreen} />
          {/if}
        {:else if LinkScreen.current}
          <LinkScreen.current />
        {:else}
          <ScreenLoading screen={LinkScreen} />
        {/if}
      {:else}
        <Library {link} {session} {route} {active} {query} {explore} {people} />
      {/if}
    {/snippet}
  </Router>
{/key}
