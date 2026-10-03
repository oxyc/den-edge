<script lang="ts">
  import PosterCard from '../src/components/PosterCard.svelte';
  import PosterRow from '../src/components/PosterRow.svelte';
  import TitleActionsProvider from './TitleActionsProvider.svelte';
  import type { Title } from '../src/lib/library';
  import '../src/app.css';

  const movie: Title = { type: 'movie', id: 101, title: 'Movie 101' };
  const series: Title = { type: 'tv', id: 701, title: 'Series 701' };
  const guestTitle: Title = { type: 'movie', id: 909, title: 'Guest Movie' };
</script>

<main style="padding:var(--bar-space) var(--gutter) 32px;max-width:1400px;margin:auto">
  <TitleActionsProvider>
    <PosterRow heading="Library">
      <PosterCard title={movie} href="/movie/101-movie-101" />
      <PosterCard title={series} href="/tv/701-series-701" continueWatching />
    </PosterRow>
  </TitleActionsProvider>
  <PosterRow heading="Guest">
    <PosterCard title={guestTitle} href="/movie/909-guest-movie" />
  </PosterRow>
  <div style="height:200vh"></div>
</main>
