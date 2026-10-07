<script lang="ts">
  import { onMount } from 'svelte';
  import Detail from '../src/components/Detail.svelte';
  import '../src/app.css';
  const noop = () => {};
  const series = new URLSearchParams(location.search).has('series');
  let active = $state(true);
  onMount(() => {
    const setActive = (event: Event) => (active = (event as CustomEvent<boolean>).detail);
    window.addEventListener('fixture:active', setActive);
    return () => window.removeEventListener('fixture:active', setActive);
  });
</script>

<main style="padding:100px 20px">
  <Detail
    ref={{ type: series ? 'tv' : 'movie', id: 42 }}
    {active}
    tmdbKey="fixture-key"
    row={undefined}
    episodes={new Map()}
    busy={false}
    failure={null}
    notice={null}
    onwatchlist={noop}
    onseen={noop}
    onreact={noop}
    onplay={noop}
    onepisode={noop}
  />
</main>
