<script lang="ts">
  import Router from '../src/Router.svelte';
  import FixturePage from './FixturePage.svelte';
  let route = $state('library');
</script>
<nav style="position:fixed;top:0;z-index:10;background:white"><a href="#library">Home</a> <a href="#movies">Movies</a> <a href="#settings">Settings</a></nav>
<Router onchange={(next) => route = next.page}>
  {#snippet children(route, active)}<FixturePage {route} {active} />{/snippet}
</Router>
