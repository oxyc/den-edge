<script lang="ts">
  import type { Route } from '../src/lib/route';
  import { navigate } from '../src/lib/navigation';
  let { route }: { route: Route; active: boolean } = $props();
  let query = $state('');
  let count = $state(6);
</script>

<section
  style="padding-top:80px"
  data-page={route.page}
  data-route-id={route.page === 'title' || route.page === 'person' ? route.id : undefined}
>
  <h1>{route.page}</h1>
  <input aria-label="Search" bind:value={query} />
  <button onclick={() => (count += 6)}>Load more</button>
  <div class="rail" style="display:flex;width:100%;overflow-x:auto;height:120px;">
    {#each Array(count) as _, i (i)}<div style="flex:0 0 200px">{i}</div>{/each}
  </div>
  <p data-count>{count}</p>
  <div style="height:900px"></div>
  <a href="#title/tv/1399">Details</a>
  <button onclick={() => navigate('#person/287')}>Person</button>
  <div style="height:1500px"></div>
</section>
