<script lang="ts">
  import PosterCard from '../src/components/PosterCard.svelte';
  import PosterRow from '../src/components/PosterRow.svelte';
  import type { Title } from '../src/lib/library';
  import '../src/app.css';

  const titles: Title[] = Array.from({ length: 10 }, (_, index) => ({
    type: 'tv',
    id: index + 1,
    title: `Coming title ${index + 1}`,
  }));
</script>

<main>
  <PosterRow heading="Coming Soon">
    {#each titles as title (title.id)}
      <PosterCard {title} caption="An Exceptional… · Sep 19" />
    {/each}
  </PosterRow>
</main>

<style>
  main {
    padding: var(--bar-space) var(--gutter);
  }
</style>
