<script lang="ts">
 import Detail from '../src/components/Detail.svelte';
 import '../src/app.css';
 const noop = () => {};
</script>
<main style="padding:100px 20px"><Detail ref={{type:'movie',id:42}} tmdbKey="fixture-key" row={undefined} episodes={new Map()} busy={false} failure={null} notice={null} onwatchlist={noop} onseen={noop} onreact={noop} onplay={noop} onepisode={noop} onselect={noop}/></main>
