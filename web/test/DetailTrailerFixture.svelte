<script lang="ts">
  import { onMount } from 'svelte';
  import Detail from '../src/components/Detail.svelte';
  import '../src/app.css';
  const noop=()=>{};
  const browserPlay=new URLSearchParams(location.search).has('browser-play');
  let active=$state(true);
  onMount(()=>{
    const change=(event:Event)=>{active=(event as CustomEvent<boolean>).detail;};
    document.addEventListener('fixture:active',change);
    return ()=>document.removeEventListener('fixture:active',change);
  });
</script>
<main style="padding:var(--bar-space) var(--gutter) 32px;max-width:1400px;margin:auto">
  <div data-route-page data-active={active} hidden={!active} style="display:flow-root">
    <Detail {active} ref={{type:'movie',id:42}} tmdbKey="fixture-key" reel="/reel/fixture"
      routes={{reel:[{url:'http://127.0.0.1:5198'}]}}
      row={undefined} episodes={new Map()} busy={false} failure={null} notice={null}
      onwatchlist={noop} onseen={noop} onreact={noop} onplay={noop} onplayhere={browserPlay?noop:undefined} onepisode={noop} onselect={noop}/>
  </div>
  <div style="height:1800px"></div>
</main>
<style>[hidden] {display:none !important;}</style>
