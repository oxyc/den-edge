<script lang="ts">
  import { onDestroy } from 'svelte';
  // The Settings page on a library that already holds what a TV would have written into it: the household's keys,
  // the TV's hide rules, an addon, and two devices. Everything is in memory, so the page has something to show
  // without a paired TV or a den-edge behind it, and a save lands where the page reads it back from.
  import Settings from '../src/Settings.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import { browserClock } from '../src/lib/clock';
  import type { LibraryLog } from '../src/lib/log';
  import {
    rowName,
    type ConfigValue,
    type Row,
    type SettingsRow,
    type Stamp,
  } from '../src/lib/wire';
  import { fixtureLibraryService } from './libraryService';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import '../src/app.css';

  const at = [1, 0, 'test'] as unknown as Stamp;
  const fixtureLibraryId = '50724b489a92805f23be6bba897393c7';
  const fixtureMemberToken = 'a17b6bb5b7e47d81e1fc40e34fe289274301987448de937c7ad2f566094fdf50';
  const row = (name: string, values: Record<string, ConfigValue>): SettingsRow => ({
    kind: 'set',
    schema: 2,
    name,
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, at }])),
  });

  // Device ids are the stamp device ids each device lists itself under, newest `seen` first on the page.
  let stored: Row[] = [
    row('keys', { tmdb: { string: 'K1' }, parentalPIN: { string: '1234' } }),
    row('prefs', {
      'den.excludedGenreIDs': { ints: [27] },
      'den.hideAnime': { bool: true },
      'den.myServicePicks': { strings: ['8@FI'] },
      'den.maturityCeiling': { string: 'pg13' },
    }),
    row('plugins', { 'https://addon.example/manifest.json': { bool: true } }),
    row('devices', {
      'aaaa000000000001.name': { string: 'Living Room TV' },
      'aaaa000000000001.kind': { string: 'tv' },
      'aaaa000000000001.seen': { int: 5000 },
      'bbbb000000000002.name': { string: 'Mac' },
      'bbbb000000000002.kind': { string: 'browser' },
      'bbbb000000000002.seen': { int: 9000 },
    }),
  ];

  const put = (next: Row) => {
    stored = [...stored.filter((held) => rowName(held) !== rowName(next)), next];
  };
  const log = {
    readOnly: false,
    wireMinimum: 4,
    currentGeneration: undefined,
    pendingActions: 0,
    libraryId: fixtureLibraryId,
    memberProof: fixtureMemberToken,
    settings: (name: string) =>
      stored.find((held): held is SettingsRow => held.kind === 'set' && held.name === name),
    refresh: async () => false,
    readToHead: async () => true,
    rows: () => stored,
    seqOf: () => 0,
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
    relayMembership: async () => ({
      libraryId: fixtureLibraryId,
      memberToken: fixtureMemberToken,
    }),
    title: () => undefined,
    episode: () => undefined,
    write: async (next: Row) => {
      put(next);
      return next;
    },
    writeAt: async (next: SettingsRow) => {
      put(next);
      return true;
    },
    writeRows: async (rows: Row[]) => {
      for (const next of rows) put(next);
      return true;
    },
    close() {},
  } as unknown as LibraryLog;

  const fixtureLibraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const library = fixtureLibraryService({
    log,
    device: browserClock().device,
    libraryKey: fixtureLibraryKey,
  });
  const { model, session } = library;
  const contentServices = createWorkerServiceSession();
  const contentModel = new LibraryModel(contentServices.library, {
    libraryKey: fixtureLibraryKey,
    mode: 'local',
  });
  const content = contentServices.content;
  let contentReady = $state(false);
  void contentModel.ready
    .then(() => contentModel.setApiKey('tmdb', 'K1', 'settings-fixture-key'))
    .then(() => (contentReady = true));
  onDestroy(() => contentServices.close());
  session.publishLibraryMetadata(
    [
      { type: 'movie', id: 550, title: 'Fight Club', year: 1999, imdbId: 'tt0137523' },
      { type: 'movie', id: 603, title: 'The Matrix', year: 1999, imdbId: 'tt0133093' },
    ],
    [],
  );
  // `?switched`: this browser just moved the library to v4, as the real session says after `switchLibraryToV4`.
  if (new URLSearchParams(location.search).has('switched')) session.toast = 'Library updated to v4';
  const link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey: fixtureLibraryKey,
    linkKey: 'fixture',
  };
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <LibraryStatus toast={session.toast} alert={session.alert} />
  {#if contentReady}<Settings {link} {model} {content} onresetkey={async () => null} />{/if}
</main>
