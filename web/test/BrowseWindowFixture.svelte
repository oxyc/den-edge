<script lang="ts">
  import Browse from '../src/components/Browse.svelte';
  import BrowseRow from '../src/components/BrowseRow.svelte';
  import PosterCard from '../src/components/PosterCard.svelte';
  import PosterRow from '../src/components/PosterRow.svelte';
  import RoutePage from '../src/components/RoutePage.svelte';
  import type { RowDef } from '../src/lib/catalog';
  import type { Title } from '../src/lib/library';
  import '../src/app.css';

  const params = new URLSearchParams(location.search);
  let active = $state(!params.has('hidden'));
  const control = params.has('all-cards');
  const catalog = params.has('catalog');
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

  (window as unknown as { fixture: { setActive: (next: boolean) => void } }).fixture = {
    setActive: (next) => (active = next),
  };
</script>

<main>
  <RoutePage {active}>
    {#if catalog}
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
</style>
