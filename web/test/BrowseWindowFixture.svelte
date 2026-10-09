<script lang="ts">
  import { onDestroy } from 'svelte';
  import Browse from '../src/components/Browse.svelte';
  import BrowseRow from '../src/components/BrowseRow.svelte';
  import PosterCard from '../src/components/PosterCard.svelte';
  import PosterRow from '../src/components/PosterRow.svelte';
  import RoutePage from '../src/components/RoutePage.svelte';
  import type { RowDef } from '../src/lib/catalog';
  import type { Title } from '../src/lib/library';
  import { atlasRows } from '../src/lib/atlasRows';
  import type { ContentServiceClientPort } from '../src/lib/contentServiceClient';
  import { SessionServices } from '../src/lib/sessionServices.svelte';
  import { fixtureContentServiceContext } from './contentService';
  import '../src/app.css';

  fixtureContentServiceContext();

  const params = new URLSearchParams(location.search);
  let active = $state(!params.has('hidden'));
  const control = params.has('all-cards');
  const catalog = params.has('catalog');
  const below = params.has('below');
  const atlasConfig = params.has('atlas-config');
  const titles: Title[] = Array.from({ length: 200 }, (_, index) => ({
    type: 'movie',
    id: index + 1,
    title: `Window title ${index + 1}`,
    posterPath: `/window-${index + 1}.jpg`,
  }));
  const row: RowDef = {
    id: 'window',
    title: 'Windowed row',
    load: async (page) => (page === 1 ? titles : []),
  };
  const rows: RowDef[] = Array.from({ length: 12 }, (_, index) => ({
    id: `catalog-${index}`,
    title: `Catalog row ${index + 1}`,
    load: async (page) => (page === 1 ? titles.slice(index, index + 4) : []),
  }));

  let acknowledgeAtlas!: () => void;
  const atlasAcknowledged = new Promise<void>((resolve) => (acknowledgeAtlas = resolve));
  let atlasQueries = $state(0);
  const heldContent = {
    query: async (request: { kind: string }) => {
      if (request.kind === 'sources.configure') {
        await atlasAcknowledged;
        return { kind: 'sources.configure' };
      }
      if (request.kind === 'atlas.row') {
        atlasQueries++;
        return {
          kind: 'atlas.row',
          titles: {
            state: 'ready',
            value: [
              {
                type: 'tv',
                id: 213344,
                title: 'Springfloden',
                posterPath: '/springfloden.jpg',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fixture content request: ${request.kind}`);
    },
    onStatus: () => () => {},
  } as unknown as ContentServiceClientPort;
  const atlasServices = atlasConfig ? new SessionServices(null, heldContent) : null;
  if (atlasServices) atlasServices.configure(undefined);
  const heldRows = $derived(
    atlasServices?.atlasReady
      ? atlasRows(heldContent, 'tv').filter((candidate) =>
          candidate.id.includes('police-procedural'),
        )
      : [],
  );

  (
    window as unknown as {
      fixture: {
        setActive: (next: boolean) => void;
        acknowledgeAtlas: () => void;
        atlasQueries: () => number;
      };
    }
  ).fixture = {
    setActive: (next) => (active = next),
    acknowledgeAtlas,
    atlasQueries: () => atlasQueries,
  };
  onDestroy(() => atlasServices?.stop());
</script>

<main class:below>
  <RoutePage {active}>
    {#if atlasConfig}
      {#if atlasServices?.atlasReady}
        <Browse rows={heldRows} shown={() => true} />
      {:else}
        <p role="status">Configuring Atlas…</p>
      {/if}
    {:else if catalog}
      <Browse {rows} shown={() => true} />
    {:else if control}
      <PosterRow heading="Windowed row">
        {#each titles as title (title.id)}
          <PosterCard {title} href={`/movie/${title.id}`} />
        {/each}
      </PosterRow>
    {:else}
      <BrowseRow {row} shown={() => true} />
    {/if}
  </RoutePage>
</main>

<style>
  main {
    padding: var(--bar-space) var(--gutter);
  }

  main.below {
    padding-top: 2400px;
  }
</style>
