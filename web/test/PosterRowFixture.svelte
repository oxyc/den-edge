<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import PosterCard from '../src/components/PosterCard.svelte';
  import PosterRow from '../src/components/PosterRow.svelte';
  import { availability } from '../src/lib/availability.svelte';
  import { setContentServiceContext } from '../src/lib/contentContext';
  import type { Title } from '../src/lib/library';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import '../src/app.css';

  const titles: Title[] = Array.from({ length: 10 }, (_, index) => ({
    type: 'tv',
    id: index + 1,
    title: `Coming title ${index + 1}`,
  }));
  const far: Title[] = Array.from({ length: 10 }, (_, index) => ({
    type: 'movie',
    id: index + 100,
    title: `Far title ${index + 1}`,
    posterPath: `/far${index + 1}.jpg`,
  }));
  const continuing: Title = {
    type: 'tv',
    id: 50,
    title: 'Continuing title',
    posterUrl: 'https://images.metahub.space/poster/medium/tt50/img',
  };
  const services = createWorkerServiceSession();
  const content = services.content;
  setContentServiceContext(content);
  onDestroy(() => services.close());

  onMount(() => {
    if (!new URLSearchParams(location.search).has('availability')) return;
    availability.connect({ install: '/scout', base: '/scout' }, content, fetch);
    return () => availability.connect(null, content);
  });
</script>

<main>
  <PosterRow heading="Coming Soon">
    {#each titles as title (title.id)}
      <PosterCard {title} caption="An Exceptional… · Sep 19" />
    {/each}
  </PosterRow>
  <PosterRow heading="Continue Watching">
    <PosterCard title={continuing} stillPath="/landscape.jpg" landscape />
  </PosterRow>
  <div style="height:4000px"></div>
  <PosterRow heading="Far below">
    {#each far as title (title.id)}
      <PosterCard {title} />
    {/each}
  </PosterRow>
</main>

<style>
  main {
    padding: var(--bar-space) var(--gutter);
  }
</style>
