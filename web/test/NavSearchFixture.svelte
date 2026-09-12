<script lang="ts">
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import { parseRoute } from '../src/lib/route';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import '../src/app.css';
  let query = $state('');
  let route = $state(parseRoute(location.hash));
  const log = {
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => [],
    newestStamp: () => [1, 0, 'test'],
    title: () => undefined,
    kept: async () => undefined,
    keep: async () => {},
  };
  const session = {
    changed: () => {},
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
  } as unknown as LibrarySession;
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
</script>

<NavigationBar {route} paired={true} bind:query />
<main style="padding:var(--bar-space) var(--gutter);max-width:1400px;margin:0 auto;overflow-x:clip">
  <Router onchange={(next) => (route = next)}>
    {#snippet children(route, active)}
      {#if route.page === 'settings'}<h1>Settings</h1>
      {:else}<Library {link} {session} {route} {active} {query} />{/if}
    {/snippet}
  </Router>
</main>
