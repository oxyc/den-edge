<!-- The player on a direct den-remux route, as a browser at home or on the tailnet plays it: the Cast spec's page.
     `?remux=/remux` plays through the relay instead, as a browser away from home does. Closing it unmounts it, as the
     app does. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Player from '../src/components/Player.svelte';
  import type { Title } from '../src/lib/library';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { rememberGrant } from '../src/lib/relayFetch';
  import { tabName } from '../src/lib/tabName.svelte';

  const query = new URLSearchParams(location.search);
  const originalLanguage = query.get('originalLanguage') ?? undefined;
  const title: Title = {
    type: 'movie',
    id: 42,
    title: 'The Movie',
    year: 2001,
    ...(originalLanguage ? { originalLanguage } : {}),
  };
  const remux = query.get('remux') ?? `${location.origin}/direct`;
  const playbackQuery = query.get('playback');
  const playback =
    playbackQuery === 'managed' ? '/den/config/playback' : (playbackQuery ?? undefined);
  const subtitleLanguage = query.get('subtitleLanguage') ?? undefined;
  const castDiscoveryMs = Number(query.get('castDiscoveryMs')) || undefined;
  const castPlayMs = Number(query.get('castPlayMs')) || undefined;
  // A guest's page names its host's install as its own (`/den/~<gid>`), as the app does for a grant.
  const scoutInstall = query.get('scout') ?? 'http://scout.test/config';
  // That guest holds the grant (`<gid>:<secret>`), as the app's GuestGrants hands it to the relay.
  const grant = query.get('grant')?.split(':');
  if (grant?.length === 2) rememberGrant(grant[0]!, grant[1]!);
  const services = createWorkerServiceSession();
  const content = services.content;
  let open = $state(true);
  onDestroy(() => services.close());
  // As App does: the name a page offers, else the address's.
  $effect(() => {
    document.title = tabName() ?? 'Den';
  });
</script>

{#if open}
  <Player
    {title}
    {content}
    scout={{ install: scoutInstall, base: '/scout/config' }}
    {remux}
    {playback}
    {subtitleLanguage}
    subtitles={[]}
    resume={{ fraction: 0 }}
    {castDiscoveryMs}
    {castPlayMs}
    onprogress={() => undefined}
    onclose={() => (open = false)}
  />
{/if}
