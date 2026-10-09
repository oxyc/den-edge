<!-- A production DedicatedWorker library, seeded once and then reopened cold. The target screen is mounted while
     the model is still connecting, so its lazy History/Connections subscription joins initial Worker hydration. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Library from '../src/Library.svelte';
  import Settings from '../src/Settings.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import { createLibraryService } from '../src/lib/libraryServiceFactory';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import { LibrarySession } from '../src/lib/librarySession.svelte';
  import type { Link } from '../src/lib/links.svelte';
  import { useLibraryCredential } from '../src/lib/relayFetch';
  import type { Route } from '../src/lib/route';
  import '../src/app.css';

  const params = new URLSearchParams(location.search);
  const seed = params.has('seed');
  const settings = params.get('view') === 'settings';
  const online = params.has('online');
  const libraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
  const libraryId = '50724b489a92805f23be6bba897393c7';
  const memberToken = 'a17b6bb5b7e47d81e1fc40e34fe289274301987448de937c7ad2f566094fdf50';
  const service = createLibraryService();
  const model = new LibraryModel(service, { libraryKey, mode: online ? 'online' : 'local' });
  const session = new LibrarySession(model, false);
  const link: Link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey,
    linkKey: 'fixture',
    deviceId: 'aaaaaaaaaaaaaaaa',
  };
  const route: Route = { page: 'watchlist' };

  // The local Worker keeps this fixture independent of a den-edge process. This is the same bounded relay
  // credential that an online Worker's membership query installs before Settings asks the host grants route.
  useLibraryCredential({ id: libraryId, member: memberToken });

  let seeded = $state(false);
  let seedFailure = $state<string | null>(null);
  if (seed) {
    void model.ready
      .then(async () => {
        const now = Date.now();
        await model.setApiKey('tmdb', 'worker-hydration-key', 'seed-key');
        await model.installPlugin(
          `${location.origin}/scout/fixture-install/manifest.json`,
          'seed-plugin',
        );
        await model.heartbeatDevice('Paired browser', 'seed-device');
        for (const id of [1002, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012])
          await model.addToWatchlist({ type: 'movie', id }, `seed-watchlist-${id}`);
        await model.recordProgress(
          {
            title: { type: 'movie', id: 1001 },
            fraction: 0.5,
            seconds: 1_800,
            observedAt: now,
          },
          'seed-continue',
        );
        await model.recordProgress(
          {
            title: { type: 'tv', id: 1003 },
            episode: { type: 'tv', id: 1003, season: 1, episode: 2 },
            fraction: 0.5,
            seconds: 1_200,
            observedAt: now - 1,
          },
          'seed-tv-continue',
        );
        await model.importHistory(
          Array.from({ length: 128 }, (_, index) => ({
            title: { type: 'movie' as const, id: 1100 + index },
            watchedAt: now - index * 60_000,
          })),
          'seed-history',
        );
        seeded = true;
      })
      .catch((error: unknown) => {
        seedFailure = error instanceof Error ? error.message : String(error);
      });
  }

  onDestroy(() => session.close());
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <LibraryStatus toast={session.toast} alert={session.alert} undo={session.undo} />
  {#if seed}
    {#if seedFailure}<p role="alert">{seedFailure}</p>{/if}
    {#if seeded}<p role="status">Worker library seeded</p>{/if}
  {:else}
    {#if settings}
      <Settings {link} {model} />
    {:else}
      <Library
        {link}
        libraryIdentity={libraryKey}
        {session}
        {route}
        active={true}
        watchedYear={undefined}
      />
    {/if}
  {/if}
</main>
