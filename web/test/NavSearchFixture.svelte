<script lang="ts">
  import { untrack } from 'svelte';
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import { parseRoute, type Explore, type PeopleView } from '../src/lib/route';
  import type { LibraryLog } from '../src/lib/log';
  import { LibrarySession } from '../src/lib/librarySession.svelte';
  import type { Row, SettingsRow, Stamp, TitleRow } from '../src/lib/wire';
  import { fixtureLibraryService } from './libraryService';
  import { fixtureContentService } from './contentService';
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
  const at = [100, 0, 'aaaaaaaaaaaaaaaa'] as const satisfies Stamp;
  const stamped = <T,>(value: T) => ({ value, at });
  const rows: Row[] = watched.map((id): TitleRow => ({
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
  const keys: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'keys',
    values: { tmdb: stamped({ string: 'fixture-key' }) },
  };
  const log = {
    readOnly: false,
    wireMinimum: 4,
    currentGeneration: undefined,
    pendingActions: 0,
    libraryId: 'fixture-library',
    memberProof: 'fixture-member',
    settings: (group: string) => (group === 'keys' ? keys : undefined),
    refresh: async () => false,
    readToHead: async () => true,
    rows: () => rows,
    seqOf: () => 0,
    newestStamp: () => at,
    title: (ref: { type: string; id: number }) =>
      rows.find(
        (row): row is TitleRow =>
          row.kind === 'rec' && row.title.type === ref.type && row.title.id === ref.id,
      ),
    episode: () => undefined,
    kept: async (name: string) =>
      name.startsWith('billboard.')
        ? (JSON.parse(localStorage.getItem(KEPT + name) ?? 'null') ?? undefined)
        : undefined,
    keep: async (name: string, value: unknown) => {
      if (name.startsWith('billboard.')) localStorage.setItem(KEPT + name, JSON.stringify(value));
    },
    relayMembership: async () => null,
    write: async (row: Row) => row,
    writeAt: async () => true,
    close() {},
  } as unknown as LibraryLog;
  const library = guest ? null : fixtureLibraryService({ log });
  const content = fixtureContentService();
  const session: LibrarySession = new LibrarySession(library?.model ?? null, true, content);
  // RoutedLibrary normally configures after opening the model; this fixture mounts Library directly.
  if (library) void library.model.ready.then(() => session.configureServices());
  else session.configureServices();
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
