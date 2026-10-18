<!-- One atlas row through the production DedicatedWorker content authority, rebuilt in place on request (`Browse`'s
     `build`), as the Movies tab rebuilds its rows. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Browse from '../src/components/Browse.svelte';
  import { atlasRows } from '../src/lib/atlasRows';
  import { setContentServiceContext } from '../src/lib/contentContext';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import '../src/app.css';

  const services = createWorkerServiceSession();
  const content = services.content;
  setContentServiceContext(content);
  onDestroy(() => services.close());

  const rows = atlasRows(content, 'movie').slice(0, 1);
  let configured = $state(false);
  let build = $state(0);
  void content
    .query({ kind: 'sources.configure', atlas: '/atlas' })
    .then(() => (configured = true));
  (window as unknown as { fixture: { rebuild: () => void } }).fixture = {
    rebuild: () => build++,
  };
</script>

<main>
  {#if configured}
    <Browse {rows} shown={() => true} {build} />
  {/if}
</main>

<style>
  main {
    padding: var(--bar-space) var(--gutter);
  }
</style>
