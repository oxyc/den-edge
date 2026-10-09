<!-- A production DedicatedWorker authority behind a title route. Seed once, then reopen the encrypted local
     library in a fresh page so detail-provider tests exercise the same Worker boundary as the application. -->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Library from '../src/Library.svelte';
  import LibraryStatus from '../src/components/LibraryStatus.svelte';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { LibraryModel } from '../src/lib/libraryModel.svelte';
  import { LibrarySession } from '../src/lib/librarySession.svelte';
  import type { Route } from '../src/lib/route';
  import '../src/app.css';

  const params = new URLSearchParams(location.search);
  const seed = params.has('seed');
  const queryContent = params.has('content');
  const queryAtlas = params.has('atlas-content');
  const libraryKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(31)));
  const services = createWorkerServiceSession();
  const model = new LibraryModel(services.library, { libraryKey, mode: 'local' });
  const session = new LibrarySession(model, true, services.content, () => services.close());
  const initialType = params.get('type') === 'movie' ? 'movie' : 'tv';
  const initialId = Number(params.get('id') ?? 308727);
  const initialQuery = params.get('q') ?? '';
  let route = $state<Route>(
    params.has('search')
      ? { page: 'search', query: initialQuery }
      : params.has('person')
        ? { page: 'person', id: initialId }
        : { page: 'title', type: initialType, id: initialId },
  );
  let seeded = $state(false);
  let seedFailure = $state<string | null>(null);
  let content = $state<string | null>(null);

  if (seed) {
    void model.ready
      .then(async () => {
        await model.setApiKey('tmdb', 'worker-detail-tmdb', 'detail-key-tmdb');
        await model.setApiKey('omdb', 'worker-detail-omdb', 'detail-key-omdb');
        await model.setApiKey('content-warnings', 'worker-detail-warnings', 'detail-key-warnings');
        await model.patchPreferences(
          { watchRegion: 'FI', shownWarnings: ['Violence'] },
          'detail-preferences',
        );
        await model.addToWatchlist({ type: 'movie', id: 9001 }, 'detail-watchlist');
        seeded = true;
      })
      .catch((error: unknown) => {
        seedFailure = error instanceof Error ? error.message : String(error);
      });
  } else if (queryContent || queryAtlas) {
    void model.ready
      .then(async () => {
        const client = session.content!;
        // Production resolves Atlas through SessionServices. This fixture asks the Worker directly, so establish the
        // same authoritative source before either Atlas reads or optional Atlas-backed title extras begin.
        await client.query({ kind: 'sources.configure', atlas: '/atlas' });
        if (queryAtlas) {
          const [filter, related, row, catalogs, chart, recommendation] = await Promise.all([
            client.query({
              kind: 'atlas.query',
              query: {
                operation: 'titles',
                type: 'movie',
                items: [{ kind: 'mood', id: 'Cozy' }],
                page: 1,
              },
            }),
            client.query({
              kind: 'atlas.related',
              query: {
                operation: 'list',
                source: 'similar',
                title: { type: 'movie', id: initialId },
                mixed: true,
                limit: 20,
              },
            }),
            client.query({ kind: 'atlas.row', type: 'movie', where: { mood: 'Cozy' }, page: 1 }),
            client.query({ kind: 'atlas.service.catalogs' }),
            client.query({
              kind: 'atlas.service.chart',
              catalog: { id: 'jw-nfx-new', type: 'movie' },
              country: 'US',
            }),
            client.query({
              kind: 'atlas.recommend.shared',
              scope: 'home',
              fresh: true,
              day: '2026-10-09',
            }),
          ]);
          content = JSON.stringify({ filter, related, row, catalogs, chart, recommendation });
          return;
        }
        const title = { type: 'tv' as const, id: initialId };
        const [titles, detail, extras, externalId, season, catalog] = await Promise.all([
          client.query({ kind: 'titles', titles: [title, { type: 'movie', id: 9001 }] }),
          client.query({ kind: 'title.detail', title, region: 'FI' }),
          client.query({ kind: 'title.extras', title, warningCategories: ['Violence'] }),
          client.query({ kind: 'title.external-id', title }),
          client.query({ kind: 'season', title, season: 1 }),
          client.query({
            kind: 'catalog.page',
            catalog: { kind: 'recommendations', title },
            page: 2,
          }),
        ]);
        content = JSON.stringify({ titles, detail, extras, externalId, season, catalog });
      })
      .catch((error: unknown) => {
        seedFailure = error instanceof Error ? error.message : String(error);
      });
  }

  onMount(() => {
    const navigate = (event: Event) => {
      const next = (event as CustomEvent<{ type: 'movie' | 'tv'; id: number }>).detail;
      route = { page: 'title', type: next.type, id: next.id };
    };
    window.addEventListener('fixture:navigate', navigate);
    return () => window.removeEventListener('fixture:navigate', navigate);
  });
  onDestroy(() => session.close());
</script>

<main>
  <LibraryStatus toast={session.toast} alert={session.alert} undo={session.undo} />
  {#if seedFailure}<p role="alert">{seedFailure}</p>{/if}
  {#if seed}
    {#if seeded}<p role="status">Worker detail library seeded</p>{/if}
  {:else if queryContent || queryAtlas}
    {#if content}
      <p role="status">Worker content ready</p>
      <pre data-content>{content}</pre>
    {/if}
  {:else}
    <Library
      link={null}
      libraryIdentity={libraryKey}
      {session}
      {route}
      query={initialQuery}
      active={true}
      watchedYear={undefined}
    />
  {/if}
</main>
