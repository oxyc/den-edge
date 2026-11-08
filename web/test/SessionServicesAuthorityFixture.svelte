<script lang="ts">
  import { SessionServices } from '../src/lib/sessionServices.svelte';
  import type { ContentServiceClientPort } from '../src/lib/contentServiceClient';
  import type { LibraryModel } from '../src/lib/libraryModel.svelte';
  import { onDestroy } from 'svelte';

  let shared = $state.raw<string[]>([]);
  let privateRemuxUrl = $state<string | null>(null);
  const content = {
    query: async () => ({ kind: 'sources.configure' as const }),
    onStatus: () => () => {},
  } as unknown as ContentServiceClientPort;
  const grants = {
    pluginUrls: () => shared,
    refresh: async () => 'verified' as const,
  };
  const model = {
    retainedServices: async () => null,
    retainServices: async () => undefined,
    rememberPrivateRemux: async (url: string) => {
      privateRemuxUrl = url;
    },
  } as unknown as LibraryModel;
  const services = new SessionServices(
    model,
    content,
    async () => ({ remux: [{ url: `${location.origin}/remux` }] }),
    grants,
  );
  $effect(() => {
    services.configure({ kind: 'runtime', pluginManifestUrls: [], privateRemuxUrl });
  });
  onDestroy(() => services.stop());

  const install = (name: string) => (shared = [`${location.origin}/scout/${name}/manifest.json`]);
  const add = (name: string) =>
    (shared = [...shared, `${location.origin}/scout/${name}/manifest.json`]);
</script>

<button onclick={() => install('a')}>A</button>
<button onclick={() => install('b')}>B</button>
<button onclick={() => add('extra')}>Add unrelated</button>
<output data-testid="plugins">{JSON.stringify(services.plugins)}</output>
<output data-testid="scout">{services.scout?.install ?? ''}</output>
<output data-testid="private-remux">{privateRemuxUrl ?? ''}</output>
{#if services.scout}
  <div data-testid="active-player">Active player</div>
{/if}
