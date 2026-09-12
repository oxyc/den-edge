<script lang="ts">
  import Router from '../src/Router.svelte';
  import NavigationBar from '../src/components/NavigationBar.svelte';
  import FixturePage from './FixturePage.svelte';
  import { parseRoute } from '../src/lib/route';
  import '../src/app.css';
  let route=$state(parseRoute(location.hash));
</script>
<NavigationBar {route} paired={true}/>
<main style="padding:var(--bar-space) var(--gutter)">
  <Router onchange={next=>route=next}>
    {#snippet children(route,active)}<FixturePage {route} {active}/>{/snippet}
  </Router>
</main>
