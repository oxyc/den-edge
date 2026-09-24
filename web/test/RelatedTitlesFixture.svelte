<script lang="ts">
  import RelatedTitles from '../src/components/RelatedTitles.svelte';
  import type { TitleDetail } from '../src/lib/detail';
  import type { Title } from '../src/lib/library';
  import '../src/app.css';

  const more: Title[] = Array.from({ length: 20 }, (_, index) => ({
    type: 'movie',
    id: index + 100,
    title: `Similar film ${index + 1}`,
    year: 2000 + index,
  }));
  const detail = {
    title: { type: 'movie', id: 1, title: 'The Seed' },
    more,
    genres: [],
    directors: [],
    writers: [],
    creators: [],
    cast: [],
  } as unknown as TitleDetail;

  let atlas = $state<string | null>(null);
  // The page learns where atlas is after the rows have shown, as a title page does when its answer is late.
  (window as unknown as { setAtlas: (url: string) => void }).setAtlas = (url) => (atlas = url);
</script>

<main>
  <div class="above"></div>
  <RelatedTitles {detail} tmdbKey="" {atlas} active={true} shown={() => true} />
</main>

<style>
  main {
    padding: var(--bar-space) var(--gutter);
  }

  .above {
    height: 1600px;
  }
</style>
