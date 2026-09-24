<script lang="ts">
  // A title page as the app mounts it — Router, Library and the title's own requests — over a library whose
  // sync the spec drives by hand (`window.fixtureSync`), so late answers can be delivered one at a time.
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import '../src/app.css';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import type { Explore, Route } from '../src/lib/route';
  import type { Row } from '../src/lib/wire';

  const stamp = [1, 0, 'test'];
  const settings: Record<string, unknown> = {
    keys: {
      kind: 'set',
      schema: 2,
      name: 'keys',
      values: { tmdb: { value: { string: 'fixture-key' }, at: stamp } },
    },
  };
  const stored: Row[] = [];
  const log = {
    settings: (group: string) => settings[group],
    refresh: async () => false,
    rows: () => stored,
    newestStamp: () => stamp,
    kept: async () => ({
      routes: { reel: [{ url: 'http://127.0.0.1:5198' }] },
      scout: null,
      atlas: '/atlas',
      reel: '/reel',
      remux: null,
    }),
    keep: async () => {},
    pendingActions: 0,
    title: () => undefined,
    episode: () => undefined,
    write: async (row: Row) => row,
    writeActions: async () => true,
    writeAction: async (row: Row) => row,
  };
  let routesGate: (value: unknown) => void = () => {};
  const session = $state({
    changed(settingsChanged = false) {
      this.revision++;
      if (settingsChanged) this.settingsRevision++;
    },
    revision: 0,
    settingsRevision: 0,
    displays: [],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
    routes: () =>
      new Promise((resolve) => {
        routesGate = resolve;
      }),
  }) as unknown as LibrarySession;
  // What Search browses, from the address, as `App.svelte` hands it down.
  let explore = $state<Explore>({});
  const follow = (route: Route) => {
    if (route.page === 'search') explore = { type: route.type, chips: route.chips };
  };
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
  const w = window as unknown as Record<string, unknown>;
  /** A library sync that brought rows; `settingsChanged` when it touched keys, plugins or prefs. */
  w.fixtureSync = (settingsChanged = false) => session.changed(settingsChanged);
  /** den-edge's routes table answering. */
  w.fixtureRoutes = () => routesGate({ reel: [{ url: 'http://127.0.0.1:5198' }] });
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Router onchange={follow}>
    {#snippet children(route, active)}
      <Library {link} {session} {route} {active} {explore} />
    {/snippet}
  </Router>
</main>
