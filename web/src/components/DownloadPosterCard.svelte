<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Download } from '../lib/downloadRows';
  import { coordinate } from '../lib/downloadRows';
  import { DOWNLOAD_STILL_RETRY_MS, downloadStill } from '../lib/downloadArtwork';
  import type { Title } from '../lib/library';
  import PosterCard from './PosterCard.svelte';

  let {
    download,
    title,
    caption,
    progress,
    badge,
    downloadBadge,
    href,
    menu = true,
    active = true,
  }: {
    download: Download;
    title: Title;
    caption?: string;
    progress?: number;
    badge?: string;
    downloadBadge?: { state: 'queued' | 'downloading' | 'trouble' | 'ready'; label: string };
    href?: string;
    menu?: boolean;
    active?: boolean;
  } = $props();

  let recoveredStill = $state<string>();
  let recoveredKey = $state<string>();
  let pendingKey = $state<string>();
  let failedKey = $state<string>();
  let failedAt = $state(0);
  let live = true;
  let visible = $state(false);
  const isEpisode = $derived(
    download.title.mediaType === 'tv' &&
      download.title.season !== undefined &&
      download.title.episode !== undefined,
  );
  // Never paint a series portrait into an episode card while its exact still is being recovered.
  const displayTitle = $derived(
    isEpisode && !download.title.stillPath && !recoveredStill
      ? { ...title, posterPath: undefined, posterUrl: undefined }
      : title,
  );
  const artworkKey = $derived(
    `${download.title.mediaType}:${download.title.mediaId}:${download.title.season ?? -1}:${download.title.episode ?? -1}:${download.title.stillPath ?? ''}`,
  );

  $effect(() => {
    const key = artworkKey;
    const stored = download.title.stillPath;
    if (stored) {
      recoveredKey = key;
      recoveredStill = stored;
      failedKey = undefined;
      return;
    }
    if (recoveredKey !== key) recoveredStill = undefined;
    if (
      !isEpisode ||
      !active ||
      !visible ||
      recoveredKey === key ||
      pendingKey === key ||
      (failedKey === key && Date.now() - failedAt < DOWNLOAD_STILL_RETRY_MS)
    )
      return;
    // Progress writes replace the row and its nested title object. Record the semantic episode key before asking,
    // so those identity-only updates do not parse the same cached season and schedule another Promise each time.
    pendingKey = key;
    void downloadStill(download.title)
      .then((still) => {
        if (!live || artworkKey !== key) return;
        pendingKey = undefined;
        if (still) {
          recoveredKey = key;
          recoveredStill = still;
          failedKey = undefined;
        } else {
          // A temporary season failure is not a permanent negative. Do not spin while this card stays reactive;
          // a later visibility activation retries it after a quiet period.
          failedKey = key;
          failedAt = Date.now();
        }
      })
      .catch(() => {
        if (!live || artworkKey !== key) return;
        pendingKey = undefined;
        failedKey = key;
        failedAt = Date.now();
      });
  });
  onDestroy(() => {
    live = false;
  });
</script>

<PosterCard
  title={displayTitle}
  stillPath={download.title.stillPath ?? recoveredStill}
  landscape
  artCaption={coordinate(download.title)}
  {badge}
  {downloadBadge}
  {caption}
  {progress}
  {href}
  {menu}
  checkAvailability={false}
  onvisibilitychange={(next) => (visible = next)}
/>
