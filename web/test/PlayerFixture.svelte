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
  import { PlaybackCursor } from '../src/lib/reel';

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
  const resumeSeconds = Number(query.get('resume')) || undefined;
  const hasNext = query.has('next');
  const reel = query.has('reel');
  // A guest's page names its host's install as its own (`/den/~<gid>`), as the app does for a grant.
  const scoutInstall = query.get('scout') ?? 'http://scout.test/config';
  // That guest holds the grant (`<gid>:<secret>`), as the app's GuestGrants hands it to the relay.
  const grant = query.get('grant')?.split(':');
  if (grant?.length === 2) rememberGrant(grant[0]!, grant[1]!);
  const services = createWorkerServiceSession();
  const content = services.content;
  let open = $state(true);
  let progress = $state<{ fraction: number; seconds: number }>();
  let closeCount = $state(0);
  let nextCount = $state(0);
  let reelUrl = $state<string>();
  onDestroy(() => services.close());
  // As App does: the name a page offers, else the address's.
  $effect(() => {
    document.title = tabName() ?? 'Den';
  });
  $effect(() => {
    if (!reel) return;
    const capability = `m/s/${'a'.repeat(40)}?s=${'b'.repeat(24)}`;
    const cursor = new PlaybackCursor([
      {
        planUrl: '/reel/sources/fixture',
        plan: {
          v: 2,
          expires: Math.floor(Date.now() / 1000) + 60,
          crop: null,
          sources: [
            {
              kind: 'hls',
              audio: true,
              width: 1920,
              height: 1080,
              delivery: { type: 'reel', capability },
            },
          ],
        },
      },
    ]);
    void cursor.first().then((step) => (reelUrl = step?.url));
    return () => cursor.close();
  });
</script>

{#if reel}
  <output data-testid="reel-media-url">{reelUrl ?? ''}</output>
{:else if open}
  <Player
    {title}
    {content}
    scout={{ install: scoutInstall, base: '/scout/config' }}
    {remux}
    {playback}
    {subtitleLanguage}
    subtitles={[]}
    resume={{ fraction: resumeSeconds ? resumeSeconds / 60 : 0, seconds: resumeSeconds }}
    next={hasNext ? 'S1 · E2' : undefined}
    {castDiscoveryMs}
    {castPlayMs}
    onprogress={(fraction, seconds) => (progress = { fraction, seconds })}
    onclose={() => {
      closeCount += 1;
      open = false;
    }}
    onnext={hasNext ? () => (nextCount += 1) : undefined}
  />
{/if}
<output data-testid="player-close-count" hidden>{closeCount}</output>
<output data-testid="player-next-count" hidden>{nextCount}</output>

{#if progress}
  <output data-testid="player-progress" hidden>{JSON.stringify(progress)}</output>
{/if}
