<script lang="ts">
  import { untrack } from 'svelte';
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import { parseRoute, type Explore, type PeopleView } from '../src/lib/route';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import { fetchRoutes } from '../src/lib/routes';
  import { SessionServices } from '../src/lib/sessionServices.svelte';
  import '../src/app.css';
  let route = $state(parseRoute(location.pathname + location.search));
  // As App does it: the address owns the query, but the field keeps what was typed while a result is open.
  // Deriving it from the current page instead empties it on the way to a title and fills it again on the way
  // back, which rebuilds the results and loses where the page was scrolled to.
  let query = $state(untrack(() => (route.page === 'search' ? route.query : '')));
  let explore = $state<Explore>(
    untrack(() => (route.page === 'search' ? { type: route.type, chips: route.chips } : {})),
  );
  $effect(() => {
    if (route.page !== 'search') return;
    query = route.query;
    explore = { type: route.type, chips: route.chips };
  });
  const peopleOf = (r: typeof route): PeopleView =>
    r.page === 'people'
      ? { query: r.query, type: r.type, chips: r.chips, traits: r.traits, order: r.order }
      : {};
  let people = $state<PeopleView>(untrack(() => peopleOf(route)));
  const guest = new URL(location.href).searchParams.has('fixtureGuest');
  // `?fixtureWatched=101,102` gives the member a library of those films, watched.
  const watched = (new URL(location.href).searchParams.get('fixtureWatched') ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  const at = [100, 0, 'test'];
  const stamped = <T,>(value: T) => ({ value, at });
  const rows = watched.map((id) => ({
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id },
    status: stamped('watched'),
    resume: { value: 0, at, viewing: 1 },
    reaction: stamped(null),
    deleted: stamped(false),
    dismissed: stamped(false),
    episodesReset: null,
    addedAt: 1,
    watchedAt: 1,
  }));
  $effect(() => {
    if (route.page === 'people') people = peopleOf(route);
  });
  // A kept billboard survives a reload, as it does in the library; nothing else is kept.
  const KEPT = 'fixture.kept.';
  const log = {
    settings: (group: string) =>
      group === 'keys'
        ? { values: { tmdb: { value: { string: 'fixture-key' }, at: [1, 0, 'test'] } } }
        : undefined,
    refresh: async () => false,
    rows: () => rows,
    newestStamp: () => [1, 0, 'test'],
    title: () => undefined,
    kept: async (name: string) =>
      name.startsWith('billboard.')
        ? (JSON.parse(localStorage.getItem(KEPT + name) ?? 'null') ?? undefined)
        : undefined,
    keep: async (name: string, value: unknown) => {
      if (name.startsWith('billboard.')) localStorage.setItem(KEPT + name, JSON.stringify(value));
    },
  };
  const session = {
    changed: () => {},
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log: guest ? null : log,
    opened: Promise.resolve(guest ? null : log),
    routes: fetchRoutes,
    services: new SessionServices(fetchRoutes, () => {}),
  } as unknown as LibrarySession;
  const link = guest ? null : { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
</script>

<NavigationBar {route} query={route.page === 'people' ? (route.query ?? '') : query} />
<main style="padding:var(--bar-space) var(--gutter);max-width:1400px;margin:0 auto;overflow-x:clip">
  <Router onchange={(next) => (route = next)}>
    {#snippet children(route, active)}
      {#if route.page === 'settings'}<h1>Settings</h1>
      {:else}<Library {link} {session} {route} {active} {query} {explore} {people} />{/if}
    {/snippet}
  </Router>
</main>
