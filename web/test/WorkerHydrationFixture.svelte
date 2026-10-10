<!-- A production DedicatedWorker library, seeded once and then reopened cold. The target screen is mounted while
     the model is still connecting, so its lazy History/Connections subscription joins initial Worker hydration. -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Library from '../src/Library.svelte';
  import Router from '../src/Router.svelte';
  import Settings from '../src/Settings.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import { LibrarySession } from '../src/lib/librarySession.svelte';
  import type { Link } from '../src/lib/links.svelte';
  import type { Route } from '../src/lib/route';
  import '../src/app.css';

  const params = new URLSearchParams(location.search);
  const seed = params.has('seed');
  let view = $state(params.get('view') === 'settings' ? 'settings' : 'library');
  const online = params.has('online');
  const lifecycle = params.has('lifecycle');
  const source = params.has('source');
  const routed = params.has('routed');
  const shell = params.has('shell');
  const libraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
  const services = createWorkerServiceSession();
  const model = new LibraryModel(services.library, {
    libraryKey,
    mode: online ? 'online' : 'local',
  });
  const session = new LibrarySession(model, false, services.content, () => services.close());
  const link: Link = {
    inboxKey: 'deadbeefcafe1234',
    name: 'Living Room TV',
    libraryKey,
    linkKey: 'fixture',
    deviceId: 'aaaaaaaaaaaaaaaa',
  };
  const route: Route = params.get('view') === 'home' ? { page: 'library' } : { page: 'watchlist' };
  let routedRoute = $state<Route>(route);
  const noop = () => {};

  $effect(() => session.configureServices());

  let seeded = $state(false);
  let seedFailure = $state<string | null>(null);
  let sourceResult = $state<string | null>(null);
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
        if (params.has('verano'))
          await model.recordProgress(
            {
              title: { type: 'tv', id: 6066 },
              episode: { type: 'tv', id: 6066, season: 1, episode: 1 },
              fraction: 0.5,
              seconds: 1_800,
              observedAt: now + 1,
            },
            'seed-verano-continue',
          );
        await model.importHistory(
          Array.from({ length: 128 }, (_, index) => ({
            title: { type: 'movie' as const, id: 1100 + index },
            watchedAt: now - index * 60_000,
          })),
          'seed-history',
        );
        await model.retainBillboard(
          { kind: 'personal', facet: null, fresh: true },
          {
            kind: 'personal',
            at: now,
            titles: [
              {
                type: 'movie',
                id: 900,
                title: 'Retained personal pick',
                year: 2025,
                posterPath: '/poster.jpg',
                backdropPath: '/backdrop.jpg',
                genreIds: [18, 10751],
              },
            ],
          },
          'seed-billboard',
        );
        if (!(await model.retainedBillboard({ kind: 'personal', facet: null, fresh: true })))
          throw new Error('retained billboard was not saved');
        if (lifecycle) {
          const title = {
            target: { type: 'movie' as const, id: 1200 },
            name: 'Queued movie',
            imdbId: 'tt1200',
          };
          const { result } = await model.downloadSources(title, true);
          if (result.kind !== 'download.sources' || !result.sources?.[0])
            throw new Error('download source was not found');
          await model.enqueueDownload(
            title,
            result.sources[0],
            result.sources.length,
            'seed-download',
          );
          await model.removePlugin(
            `${location.origin}/scout/fixture-install/manifest.json`,
            'remove-seed-plugin',
          );
        }
        seeded = true;
      })
      .catch((error: unknown) => {
        seedFailure = error instanceof Error ? error.message : String(error);
      });
  }

  if (source) {
    void model.ready
      .then(async () => {
        const { result } = await model.downloadSources({
          target: { type: 'tv', id: 213344, season: 1, episode: 1 },
          name: 'Springfloden',
          imdbId: 'tt5194410',
        });
        sourceResult =
          result.kind === 'download.sources' && result.sources?.length
            ? 'Worker episode sources ready'
            : 'Worker episode sources unavailable';
      })
      .catch(() => (sourceResult = 'Worker episode sources unavailable'));
  }

  onMount(() => {
    if (params.has('roundtrip-detail')) {
      const fixtureWindow = window as typeof window & {
        fixtureClearTmdbCache?: () => Promise<unknown>;
      };
      fixtureWindow.fixtureClearTmdbCache = () =>
        services.content.query({ kind: 'provider-cache.clear', service: 'tmdb' });
      return () => {
        delete fixtureWindow.fixtureClearTmdbCache;
      };
    }
    if (!lifecycle) return;
    let stopped = false;
    const observe = () => {
      if (stopped) return;
      void model
        .observeLifecycle({
          visible: !document.hidden,
          online: navigator.onLine,
          playbackActive: false,
        })
        .catch(() => {});
    };
    void model.ready.then(async () => {
      if (stopped) return;
      observe();
      await model.foregroundReady();
    });
    window.addEventListener('online', observe);
    window.addEventListener('offline', observe);
    document.addEventListener('visibilitychange', observe);
    return () => {
      stopped = true;
      window.removeEventListener('online', observe);
      window.removeEventListener('offline', observe);
      document.removeEventListener('visibilitychange', observe);
    };
  });

  onDestroy(() => session.close());
</script>

{#if routed && shell}<NavigationBar route={routedRoute} />{/if}
<main style="padding:var(--bar-space) var(--gutter)">
  <LibraryStatus toast={session.toast} alert={session.alert} undo={session.undo} />
  {#if sourceResult}<p role="status">{sourceResult}</p>{/if}
  {#if seed}
    {#if seedFailure}<p role="alert">{seedFailure}</p>{/if}
    {#if seeded}<p role="status">Worker library seeded</p>{/if}
  {:else if source}
    <!-- The source probe is deliberately the first provider operation after Worker bootstrap. Mounting Home here
         would let unrelated metadata work initialize relay membership and hide the direct-IMDb regression. -->
  {:else}
    <nav aria-label="Fixture pages">
      <button type="button" onclick={() => (view = 'library')}>Open Home</button>
      <button type="button" onclick={() => (view = 'settings')}>Open Settings</button>
    </nav>
    {#if view === 'settings'}
      <Settings {link} {model} />
    {:else if routed}
      <Router onchange={(next) => (routedRoute = next)}>
        {#snippet children(route, active)}
          <Library
            {link}
            libraryIdentity={libraryKey}
            {session}
            {route}
            {active}
            watchedYear={undefined}
          />
        {/snippet}
      </Router>
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
