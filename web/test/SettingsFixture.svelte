<script lang="ts">
  // The Settings page on a library that already holds what a TV would have written into it: the household's keys,
  // the TV's hide rules, an addon, and two devices. Everything is in memory, so the page has something to show
  // without a paired TV or a den-edge behind it, and a save lands where the page reads it back from.
  import Settings from '../src/Settings.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import type { LibrarySession } from '../src/lib/librarySession.svelte';
  import { fetchRoutes } from '../src/lib/routes';
  import type { ConfigValue, Row, SettingsRow, Stamp } from '../src/lib/wire';
  import '../src/app.css';

  const at = [1, 0, 'test'] as unknown as Stamp;
  const row = (name: string, values: Record<string, ConfigValue>): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name,
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, at }])),
  });

  // Device ids are the stamp device ids each device lists itself under, newest `seen` first on the page.
  const settings: Record<string, SettingsRow> = {
    keys: row('keys', { tmdb: { string: 'K1' }, parentalPIN: { string: '1234' } }),
    prefs: row('prefs', {
      'den.excludedGenreIDs': { ints: [27] },
      'den.hideAnime': { bool: true },
      'den.myServicePicks': { strings: ['8@FI'] },
      'den.maturityCeiling': { string: 'pg13' },
    }),
    plugins: row('plugins', { 'https://addon.example/manifest.json': { bool: true } }),
    devices: row('devices', {
      'aaaa000000000001.name': { string: 'Living Room TV' },
      'aaaa000000000001.kind': { string: 'tv' },
      'aaaa000000000001.seen': { int: 5000 },
      'bbbb000000000002.name': { string: 'Mac' },
      'bbbb000000000002.kind': { string: 'browser' },
      'bbbb000000000002.seen': { int: 9000 },
    }),
  };

  const imported: Row[] = [];
  const log = {
    settings: (name: string) => settings[name],
    // A write lands in the same map the page reads, so a change made here shows here.
    write: async (next: SettingsRow) => {
      settings[next.name] = next;
      return true;
    },
    moved: false,
    wireMinimum: 4,
    refresh: async () => false,
    rows: () => Object.values(settings),
    // One film seen twice and one on the watchlist, for the history export.
    documents: () => [
      {
        seq: 1,
        document: {
          format: 4,
          kind: 'title',
          title: { type: 'movie', id: 550 },
          status: { value: 'watched', at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'] },
          resume: { value: 1, at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'], viewing: 1 },
          reaction: { value: 'love', at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'] },
          watch: { plays: { '0': 1_760_000_000_000, '1': 1_789_000_000_000 }, cleared: null },
        },
      },
      {
        seq: 2,
        document: {
          format: 4,
          kind: 'title',
          title: { type: 'movie', id: 603 },
          status: { value: 'watchlist', at: [1_789_000_000_000, 0, 'a1b2c3d4e5f60718'] },
        },
      },
    ],
    newestStamp: () => at,
    kept: async () => undefined,
    keep: async () => {},
    title: () => undefined,
    episode: () => undefined,
    refusal: null as string | null,
    writeRows: async (rows: Row[]) => {
      imported.push(...rows);
      return true;
    },
  };

  const session = $state({
    // Bumped as the real session does, so what a save wrote is what the page draws next.
    changed(settings = false) {
      this.revision++;
      if (settings) this.settingsRevision++;
    },
    revision: 0,
    settingsRevision: 0,
    displays: [
      { type: 'movie', id: 550, title: 'Fight Club', year: 1999, imdbId: 'tt0137523' },
      { type: 'movie', id: 603, title: 'The Matrix', year: 1999, imdbId: 'tt0133093' },
    ],
    shapes: new Map(),
    log,
    opened: Promise.resolve(log),
    routes: fetchRoutes,
    // `?switched`: this browser just moved the library to v4, as the real session says after `switchLibraryToV4`.
    toast: new URLSearchParams(location.search).has('switched') ? 'Library updated to v4' : null,
    alert: null,
  }) as unknown as LibrarySession;
  const fixtureLibraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey: fixtureLibraryKey,
    linkKey: 'fixture',
  };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <LibraryStatus toast={session.toast} alert={session.alert} />
  <Settings {link} {session} />
</main>
