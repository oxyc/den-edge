<!-- The player on a direct den-remux route, as a browser at home or on the tailnet plays it: the Cast spec's page.
     `?remux=/remux` plays through the relay instead, as a browser away from home does. Closing it unmounts it, as the
     app does. -->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Player from '../src/components/Player.svelte';
  import type { Title } from '../src/lib/library';
  import { createWorkerServiceSession } from '../src/lib/libraryServiceFactory';
  import { isInterfaceLanguage } from '../src/lib/interfaceLanguage';
  import { setInterfaceLanguage } from '../src/lib/i18n.svelte';
  import { rememberGrant } from '../src/lib/relayFetch';
  import { tabName } from '../src/lib/tabName.svelte';
  import { PlaybackCursor } from '../src/lib/reel';

  const query = new URLSearchParams(location.search);
  const startsClosed = query.has('startClosed');
  const languageControls = query.has('languageControls');
  const originalLanguage = query.get('originalLanguage') ?? undefined;
  const title: Title = {
    // `?series`: an episode, whose season the player can describe the next one from.
    type: query.has('series') ? 'tv' : 'movie',
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
  const requestedInterfaceLanguage = query.get('interfaceLanguage');
  const initialInterfaceLanguage = isInterfaceLanguage(requestedInterfaceLanguage)
    ? requestedInterfaceLanguage
    : 'en';
  let interfaceLanguage = $state(initialInterfaceLanguage);

  function replaceInterfaceLanguage(language: 'en' | 'es' | 'sv') {
    interfaceLanguage = language;
    void setInterfaceLanguage(language);
  }
  replaceInterfaceLanguage(initialInterfaceLanguage);
  const shownSubtitleLanguages = query.get('shownSubtitles')?.split(',').filter(Boolean);
  const maxSubtitlesPerLanguage = Number(query.get('subtitlesPerLanguage')) || undefined;
  const playbackSourcePolicy = query.get('sourcePolicy') === 'remember' ? 'remember' : 'best';
  const preferredPlaybackSource =
    query.get('preferredSource') === 'torbox' || query.get('preferredSource') === 'den-remux'
      ? (query.get('preferredSource') as 'torbox' | 'den-remux')
      : undefined;
  const castPlayMs = Number(query.get('castPlayMs')) || undefined;
  const receiptBoundary = query.has('receiptBoundary');
  const receiptDelayMs = Number(query.get('receiptDelayMs')) || 0;
  const resumeSeconds = Number(query.get('resume')) || undefined;
  // `?resumeFraction`: the stored fraction beside `?resume`, as a library row saved it; otherwise seconds of a minute.
  const resumeFraction = Number(query.get('resumeFraction')) || undefined;
  const hasNext = query.has('next');
  // `?autoSkip`: Settings › Playback's auto-skip on, with a control that turns it off mid-play as a synced change would.
  let autoSkip = $state(query.has('autoSkip'));
  // Which episode is next, so the dock's next-episode button has somewhere to go.
  const nextEpisode = query.has('nextEpisode') ? { season: 1, episode: 2 } : undefined;
  const reel = query.has('reel');
  // `?episodes`: S1 · E1 of a series with two seasons, the second aired through E1, and S1 · E2 half watched. Picking
  // an episode plays it in this player, as the app's advance does.
  const listsEpisodes = query.has('episodes');
  const replacesEpisode = query.has('replaceEpisode');
  let playingAt = $state(listsEpisodes || replacesEpisode ? { season: 1, episode: 1 } : {});
  let picked = $state<string[]>([]);
  // A guest's page names its host's install as its own (`/den/~<gid>`), as the app does for a grant.
  const scoutInstall = query.get('scout') ?? 'http://scout.test/config';
  // That guest holds the grant (`<gid>:<secret>`), as the app's GuestGrants hands it to the relay.
  const grant = query.get('grant')?.split(':');
  if (grant?.length === 2) rememberGrant(grant[0]!, grant[1]!);
  const services = createWorkerServiceSession();
  const content = services.content;
  let open = $state(!startsClosed);
  let progress = $state<{ fraction: number; seconds: number; playing: boolean }>();
  let progressWrites = $state(0);
  let closeCount = $state(0);
  let receiptSettingsCount = $state(0);
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
    season={playingAt.season}
    episode={playingAt.episode}
    filename={query.get('filename') ?? undefined}
    {content}
    region="US"
    scout={{ install: scoutInstall, base: '/scout/config' }}
    releaseAuthority={[
      'fixture:owner',
      'fixture-library',
      'fixture-household',
      scoutInstall,
      '/scout/config',
    ]}
    {remux}
    {playback}
    {interfaceLanguage}
    {autoSkip}
    {subtitleLanguage}
    {shownSubtitleLanguages}
    {maxSubtitlesPerLanguage}
    {playbackSourcePolicy}
    {preferredPlaybackSource}
    subtitles={[]}
    resume={{
      fraction: resumeFraction ?? (resumeSeconds ? resumeSeconds / 60 : 0),
      seconds: resumeSeconds,
    }}
    next={hasNext ? 'S1 · E2' : undefined}
    {nextEpisode}
    {castPlayMs}
    onmanagedplayback={receiptBoundary
      ? async (signal) => {
          if (!__DEN_MANAGED_PLAYBACK_RECEIPTS__) return 'unsupported';
          if (receiptDelayMs)
            // Deliberately ignore cancellation: Player owns the complete callback deadline, including production's
            // lazy import and a Library Service reconnect that might not settle when the signal fires.
            await new Promise<void>((resolve) => setTimeout(resolve, receiptDelayMs));
          const response = await fetch('/test/receipt-ready', { method: 'POST', signal });
          if (!response.ok) throw new Error('receipt authority failed');
          return 'ready';
        }
      : undefined}
    playbackReceiptHandoffAsOwner={true}
    onplaybackreceipthandoff={() => (receiptSettingsCount += 1)}
    onprogress={(fraction, seconds, _at, playing) => {
      progress = { fraction, seconds, playing };
      progressWrites += 1;
    }}
    onfinalprogress={(fraction, seconds, _at, playing) => {
      progress = { fraction, seconds, playing };
      progressWrites += 1;
    }}
    onclose={() => {
      closeCount += 1;
      open = false;
    }}
    onnext={hasNext ? () => (nextCount += 1) : undefined}
    seasons={listsEpisodes
      ? [
          { number: 1, aired: 3 },
          { number: 2, aired: 1 },
          { number: 0, aired: 1 },
        ]
      : undefined}
    episodeProgress={(season, episode) => (season === 1 && episode === 2 ? 0.5 : 0)}
    onepisode={listsEpisodes
      ? (at) => {
          picked = [...picked, `S${at.season}E${at.episode}`];
          playingAt = at;
        }
      : undefined}
  />
{/if}
{#if startsClosed}
  <button type="button" onclick={() => (open = true)}>Open fixture player</button>
{/if}
{#if replacesEpisode}
  <button
    type="button"
    data-testid="replace-player-episode"
    onclick={() => (playingAt = { season: 2, episode: 1 })}>Replace episode</button
  >
{/if}
{#if query.has('autoSkip')}
  <button type="button" data-testid="auto-skip-off" onclick={() => (autoSkip = false)}
    >Turn auto-skip off</button
  >
{/if}
{#if languageControls}
  {#each ['en', 'es', 'sv'] as language (language)}
    <button
      type="button"
      data-testid={`interface-language-${language}`}
      onclick={() => replaceInterfaceLanguage(language as 'en' | 'es' | 'sv')}
      >Use {language} interface</button
    >
  {/each}
{/if}
<output data-testid="player-close-count" hidden>{closeCount}</output>
<output data-testid="receipt-settings-count" hidden>{receiptSettingsCount}</output>
<output data-testid="player-next-count" hidden>{nextCount}</output>
<output data-testid="player-picked-episodes" hidden>{picked.join(',')}</output>
<output data-testid="player-progress-writes" hidden>{progressWrites}</output>

{#if progress}
  <output data-testid="player-progress" hidden>{JSON.stringify(progress)}</output>
{/if}
