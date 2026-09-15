<script lang="ts">
  import { onMount } from 'svelte';
  import type { Title } from '../src/lib/library';
  import Billboard from '../src/components/Billboard.svelte';
  import '../src/app.css';
  let titles = $state<Title[]>([]);
  // Off unless a test asks for it: the specs that measure layout mock no reel, and handing them one
  // would have them fetching a trailer the network guard refuses.
  const reel = new URLSearchParams(location.search).has('reel') ? '/reel/fixture' : null;
  onMount(() => {
    const load = () => {
      titles = [
        { type: 'movie', id: 42, title: 'A short title', year: 2026, backdropPath: '/early.jpg' },
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
  <Billboard
    {titles}
    tmdbKey="fixture-key"
    {reel}
    routes={{ reel: [{ url: 'http://internal' }] }}
  />
  <p data-following-content>Following content</p>
  <div style="height:1800px"></div>
</main>
