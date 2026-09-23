<!-- The player on a direct den-remux route, as a browser at home or on the tailnet plays it: the Cast spec's page. -->
<script lang="ts">
  import Player from '../src/components/Player.svelte';
  import type { Title } from '../src/lib/library';

  const title: Title = { type: 'movie', id: 42, title: 'The Movie' };
</script>

<Player
  {title}
  tmdbKey="fixture"
  scout={{ install: 'http://scout.test/config', base: '/scout/config' }}
  remux="http://127.0.0.1:5198/direct"
  subtitles={[]}
  resume={{ fraction: 0 }}
  onprogress={() => undefined}
  onclose={() => undefined}
/>
