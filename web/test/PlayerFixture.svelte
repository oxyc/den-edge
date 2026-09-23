<!-- The player on a direct den-remux route, as a browser at home or on the tailnet plays it: the Cast spec's page.
     `?remux=/remux` plays through the relay instead, as a browser away from home does. Closing it unmounts it, as the
     app does. -->
<script lang="ts">
  import Player from '../src/components/Player.svelte';
  import type { Title } from '../src/lib/library';

  const title: Title = { type: 'movie', id: 42, title: 'The Movie' };
  const remux = new URLSearchParams(location.search).get('remux') ?? 'http://127.0.0.1:5198/direct';
  let open = $state(true);
</script>

{#if open}
  <Player
    {title}
    tmdbKey="fixture"
    scout={{ install: 'http://scout.test/config', base: '/scout/config' }}
    {remux}
    subtitles={[]}
    resume={{ fraction: 0 }}
    onprogress={() => undefined}
    onclose={() => (open = false)}
  />
{/if}
