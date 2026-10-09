<script lang="ts">
  import { onMount } from 'svelte';
  import type { RecommendedTitle } from '../src/lib/recommend';
  import Billboard from '../src/components/Billboard.svelte';
  import { fixtureContentServiceContext } from './contentService';
  import '../src/app.css';
  let titles = $state<RecommendedTitle[]>([]);
  let active = $state(true);
  const content = fixtureContentServiceContext();
  // Off unless a test asks for it: the specs that measure layout mock no reel, and handing them one
  // would have them fetching a trailer the network guard refuses.
  const reel = new URLSearchParams(location.search).has('reel') ? '/reel/fixture' : null;
  onMount(() => {
    const load = () => {
      titles = [
        {
          type: 'movie',
          id: 42,
          title: 'A short title',
          year: 2026,
          backdropPath: '/early.jpg',
          why: { reason: 'profile' },
        },
        {
          type: 'movie',
          id: 43,
          title:
            'A much longer movie title that should occupy its reserved space without moving the overview or controls',
          year: 2026,
        },
      ];
    };
    const republish = () => {
      titles = titles.map((title) => ({ ...title }));
    };
    const setActive = (event: Event) => (active = (event as CustomEvent<boolean>).detail);
    window.addEventListener('fixture:titles', load);
    window.addEventListener('fixture:republish', republish);
    window.addEventListener('fixture:active', setActive);
    return () => {
      window.removeEventListener('fixture:titles', load);
      window.removeEventListener('fixture:republish', republish);
      window.removeEventListener('fixture:active', setActive);
    };
  });
</script>

<main style="padding:var(--bar-space) var(--gutter)">
  <Billboard {titles} {active} {content} {reel} routes={{ reel: [{ url: 'http://internal' }] }} />
  <p data-following-content>Following content</p>
  <div style="height:1800px"></div>
</main>
