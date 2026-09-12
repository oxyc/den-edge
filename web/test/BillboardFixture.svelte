<script lang="ts">
  import { onMount } from 'svelte';
  import type { Title } from '../src/lib/library';
  import Billboard from '../src/components/Billboard.svelte';
  import '../src/app.css';
  let titles = $state<Title[]>([]);
  onMount(() => {
    const load = () => {
      titles = [
        { type: 'movie', id: 42, title: 'A short title', year: 2026 },
        {
          type: 'movie',
          id: 43,
          title:
            'A much longer movie title that should occupy its reserved space without moving the overview or controls',
          year: 2026,
        },
      ];
    };
    window.addEventListener('fixture:titles', load);
    return () => window.removeEventListener('fixture:titles', load);
  });
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Billboard {titles} tmdbKey="fixture-key" />
  <p data-following-content>Following content</p>
  <div style="height:1800px"></div>
</main>
