<script lang="ts">
  import Router from '../src/Router.svelte';
  import PosterCard from '../src/components/PosterCard.svelte';
  import WindowedPosterRow from '../src/components/WindowedPosterRow.svelte';
  import { setContentServiceContext } from '../src/lib/contentContext';
  import type { Title } from '../src/lib/library';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import '../src/app.css';

  const services = createWorkerServiceSession();
  setContentServiceContext(services.content);
  const titles: Title[] = Array.from({ length: 8 }, (_, index) => ({
    type: 'tv',
    id: 6000 + index,
    title: `Continuing series ${index + 1}`,
    posterPath: `/continuing-${index + 1}.jpg`,
  }));
  // The shelf starts below the screen, still inside its near window.
  const below = new URLSearchParams(location.search).has('below');
</script>

<main>
  <Router onchange={() => {}}>
    {#snippet children(route)}
      {#if route.page === 'library'}
        <div class="hero" class:below aria-hidden="true"></div>
        <WindowedPosterRow
          heading="Continue Watching"
          items={titles}
          itemKey={(title) => `${title.type}:${title.id}`}
          itemHref={(title) => `/tv/${title.id}-continuing-series-${title.id - 5999}`}
          itemLabel={(title) => title.title}
        >
          {#snippet children(title, onscreen)}
            <PosterCard
              {title}
              caption="S1 · E1"
              href={`/tv/${title.id}-continuing-series-${title.id - 5999}`}
              continueWatching
              {onscreen}
            />
          {/snippet}
        </WindowedPosterRow>
      {:else if route.page === 'title'}
        <h1>{titles.find((title) => title.id === route.id)?.title}</h1>
      {/if}
    {/snippet}
  </Router>
</main>

<style>
  main {
    padding: var(--bar-space) var(--gutter);
  }

  .hero {
    height: 320px;
  }

  .hero.below {
    height: 1100px;
  }
</style>
