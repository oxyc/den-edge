<script lang="ts">
  import Router from '../src/Router.svelte';
  import Library from '../src/Library.svelte';
  import { LibrarySession } from '../src/lib/librarySession.svelte';
  import { fixtureContentServiceContext } from './contentService';
  import '../src/app.css';
  const noop = () => {};
  // This routing fixture is intentionally a guest: current session semantics make that a real session with no model.
  const session = new LibrarySession(null, false, fixtureContentServiceContext());
  session.configureServices();
  const link = null;
</script>

<main style="padding:var(--bar-space) var(--gutter);max-width:1400px;margin:0 auto;overflow-x:clip">
  <Router onchange={noop}>
    {#snippet children(route, active)}<Library {link} {session} {route} {active} />{/snippet}
  </Router>
</main>
