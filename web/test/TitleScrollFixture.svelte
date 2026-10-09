<script lang="ts">
  // A title page as the app mounts it — Router, Library and the title's own requests — over a library whose
  // sync the spec drives by hand (`window.fixtureSync`), so late answers can be delivered one at a time.
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import '../src/app.css';
  import type { LibraryLog } from '../src/lib/log';
  import type { Explore, Route } from '../src/lib/route';
  import { rowName, type Row, type SettingsRow, type Stamp, type TitleRow } from '../src/lib/wire';
  import { fixtureLibraryService } from './libraryService';

  const device = 'aaaaaaaaaaaaaaaa';
  const stamp = [1, 0, device] as unknown as Stamp;
  const keys: SettingsRow = {
    kind: 'set',
    schema: 2,
    name: 'keys',
    values: { tmdb: { value: { string: 'fixture-key' }, at: stamp } },
  };
  let stored: Row[] = [keys];
  const put = (next: Row) => {
    stored = [...stored.filter((held) => rowName(held) !== rowName(next)), next];
  };
  const log = {
    readOnly: false,
    wireMinimum: 4,
    currentGeneration: undefined,
    pendingActions: 0,
    libraryId: 'fixture-library',
    memberProof: 'fixture-member',
    settings: (group: string) =>
      stored.find((row): row is SettingsRow => row.kind === 'set' && row.name === group),
    refresh: async () => false,
    readToHead: async () => true,
    rows: () => stored,
    seqOf: () => 0,
    newestStamp: () => stamp,
    kept: async (name: string) =>
      name === 'services.v1'
        ? {
            routes: { reel: [{ url: location.origin }] },
            scout: null,
            atlas: '/atlas',
            reel: '/reel',
            remux: null,
          }
        : undefined,
    keep: async () => {},
    relayMembership: async () => null,
    title: (ref: { type: string; id: number }) =>
      stored.find(
        (row): row is TitleRow =>
          row.kind === 'rec' && row.title.type === ref.type && row.title.id === ref.id,
      ),
    episode: () => undefined,
    write: async (row: Row) => {
      put(row);
      return row;
    },
    writeAt: async (row: Row) => {
      put(row);
      return true;
    },
    close() {},
  } as unknown as LibraryLog;
  const library = fixtureLibraryService({ log, device });
  const { session } = library;
  // The visit begins with the retained answer while live `/routes` discovery is deliberately held by the spec.
  // RoutedLibrary normally configures after opening the model; this fixture mounts Library directly.
  void library.model.ready.then(() => session.configureServices());
  // What Search browses, from the address, as `App.svelte` hands it down.
  let explore = $state<Explore>({});
  const follow = (route: Route) => {
    if (route.page === 'search') explore = { type: route.type, chips: route.chips };
  };
  const link = { inboxKey: 'fixture', libraryKey: 'fixture', linkKey: 'fixture' };
  const w = window as unknown as Record<string, unknown>;
  let sync = 0;
  /** Publish the same independently replaceable overview/settings views that a real library sync affects. */
  w.fixtureSync = async (settingsChanged = false) => {
    const at = [200 + ++sync, 0, device] as unknown as Stamp;
    if (settingsChanged) {
      put({
        kind: 'set',
        schema: 2,
        name: 'prefs',
        values: { 'den.hideAnime': { value: { bool: true }, at } },
      });
      await library.publish([{ kind: 'settings' }]);
      return;
    }
    put({
      kind: 'rec',
      schema: 2,
      title: { type: 'movie', id: 9000 + sync },
      status: { value: 'watched', at },
      resume: { value: 0, at, viewing: 1 },
      reaction: { value: null, at },
      deleted: { value: false, at },
      dismissed: { value: false, at },
      episodesReset: null,
      addedAt: at[0],
      watchedAt: at[0],
    });
    await library.publish([{ kind: 'overview' }]);
  };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Router onchange={follow}>
    {#snippet children(route, active)}
      <Library {link} {session} {route} {active} {explore} />
    {/snippet}
  </Router>
</main>
