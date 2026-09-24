<script lang="ts">
  import Router from '../src/Router.svelte';
  import FixturePage from './FixturePage.svelte';
  import { tabName } from '../src/lib/tabName.svelte';
  import type { Route } from '../src/lib/route';
  // As App names the tab.
  let page = $state<Route['page']>('library');
  $effect(() => {
    document.title = tabName() ?? page;
  });
</script>

<nav style="position:fixed;top:0;z-index:10;background:white">
  <a href="/">Home</a> <a href="/movies">Movies</a> <a href="/settings">Settings</a>
</nav>
<Router onchange={(route) => (page = route.page)}>
  {#snippet children(route, active)}<FixturePage {route} {active} />{/snippet}
</Router>
