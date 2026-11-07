<script lang="ts">
  import { SessionServices } from '../src/lib/sessionServices.svelte';
  import type { ContentServiceClientPort } from '../src/lib/contentServiceClient';
  import { onDestroy } from 'svelte';

  let shared = $state.raw<string[]>([]);
  const content = {
    query: async () => ({ kind: 'sources.configure' as const }),
    onStatus: () => () => {},
  } as unknown as ContentServiceClientPort;
  const grants = {
    pluginUrls: () => shared,
    refresh: async () => 'verified' as const,
  };
  const services = new SessionServices(null, content, async () => ({}), grants);
  $effect(() => {
    services.configure({ kind: 'runtime', pluginManifestUrls: [], privateRemuxUrl: null });
  });
  onDestroy(() => services.stop());

  const install = (name: string) => (shared = [`${location.origin}/scout/${name}/manifest.json`]);
</script>

<button onclick={() => install('a')}>A</button>
<button onclick={() => install('b')}>B</button>
<output data-testid="plugins">{JSON.stringify(services.plugins)}</output>
<output data-testid="scout">{services.scout?.install ?? ''}</output>
