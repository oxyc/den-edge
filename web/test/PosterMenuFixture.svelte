<script lang="ts">
  import PosterCard from '../src/components/PosterCard.svelte';
  import PosterRow from '../src/components/PosterRow.svelte';
  import TitleActionsProvider from './TitleActionsProvider.svelte';
  import type { Title } from '../src/lib/library';
  import '../src/app.css';

  const movie: Title = { type: 'movie', id: 101, title: 'Movie 101' };
  const series: Title = { type: 'tv', id: 701, title: 'Series 701' };
  const guestTitle: Title = { type: 'movie', id: 909, title: 'Guest Movie' };
  const scale = Number(new URL(location.href).searchParams.get('scale') ?? 0);
  const scaleTitles: Title[] = Array.from({ length: scale }, (_, index) => ({
    type: 'tv',
    id: 10_000 + index,
    title: `Scale Series ${index + 1}`,
  }));
</script>

<main style="padding:var(--bar-space) var(--gutter) 32px;max-width:1400px;margin:auto">
  <TitleActionsProvider>
    <PosterRow heading="Library">
      <PosterCard title={movie} href="/movie/101-movie-101" />
      <PosterCard title={series} href="/tv/701-series-701" continueWatching />
    </PosterRow>
    {#if scaleTitles.length}
      <div data-menu-scale class="scale">
        {#each scaleTitles as title (title.id)}
          <PosterCard {title} href={`/tv/${title.id}-scale`} />
        {/each}
      </div>
    {/if}
  </TitleActionsProvider>
  <PosterRow heading="Guest">
    <PosterCard title={guestTitle} href="/movie/909-guest-movie" />
  </PosterRow>
  <div style="height:200vh"></div>
</main>

<style>
  .scale {
    position: absolute;
    top: 0;
    left: -100000px;

    --card-w: 190px;
  }
</style>
