<script lang="ts">
  import { onMount } from 'svelte';
  import Detail from '../src/components/Detail.svelte';
  import '../src/app.css';
  const noop = () => {};
  const ref = { type: 'movie' as const, id: 42 };
  const browserPlay = new URLSearchParams(location.search).has('browser-play');
  let active = $state(true);
  // What SessionServices.configure() would publish for `reel`/`routes`: a restored `services.v1`
  // result first, then replaced by live `/routes` discovery. `fixture:reel` lets a spec fire that
  // second publish mid-page, the way a cold route's discovery race does (oxyc/den-edge#281).
  let reel = $state('/reel/fixture');
  let routes = $state({ reel: [{ url: location.origin }] });
  let settingsRevision = $state(0);
  const detailPrefs = $derived.by(() => {
    void settingsRevision;
    return {
      region: 'US',
      autoplay: true,
      ratingSources: ['imdb', 'tmdb', 'rottenTomatoes', 'metacritic'],
      warningCategories: [],
    };
  });
  onMount(() => {
    const change = (event: Event) => {
      active = (event as CustomEvent<boolean>).detail;
    };
    const rediscover = (event: Event) => {
      const detail = (event as CustomEvent<{ base: string }>).detail;
      reel = detail.base;
      routes = { reel: [{ url: location.origin }] };
    };
    const refreshSettings = () => settingsRevision++;
    document.addEventListener('fixture:active', change);
    document.addEventListener('fixture:reel', rediscover);
    document.addEventListener('fixture:settings', refreshSettings);
    return () => {
      document.removeEventListener('fixture:active', change);
      document.removeEventListener('fixture:reel', rediscover);
      document.removeEventListener('fixture:settings', refreshSettings);
    };
  });
</script>

<main style="padding:var(--bar-space) var(--gutter) 32px;max-width:1400px;margin:auto">
  <div data-route-page data-active={active} hidden={!active} style="display:flow-root">
    <Detail
      {active}
      {ref}
      tmdbKey="fixture-key"
      {reel}
      {routes}
      region={detailPrefs.region}
      autoplay={detailPrefs.autoplay}
      ratingSources={detailPrefs.ratingSources}
      warningCategories={detailPrefs.warningCategories}
      row={undefined}
      episodes={new Map()}
      busy={false}
      failure={null}
      notice={null}
      onwatchlist={noop}
      onseen={noop}
      onreact={noop}
      onplay={noop}
      onplayhere={browserPlay ? noop : undefined}
      onepisode={noop}
    />
  </div>
  <div style="height:1800px"></div>
</main>

<style>
  [hidden] {
    display: none !important;
  }
</style>
