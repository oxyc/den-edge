<script lang="ts">
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import '../src/app.css';
  const noop = () => {};
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

<main style="padding:var(--bar-space) var(--gutter);max-width:1400px;margin:0 auto;overflow-x:clip">
  <Router onchange={noop}>
    {#snippet children(route, active)}<Library {link} {session} {route} {active} />{/snippet}
  </Router>
</main>
