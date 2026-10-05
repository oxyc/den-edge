<script lang="ts">
  import type { Download } from '../lib/downloadRows';
  import { coordinate } from '../lib/downloadRows';
  import { downloadStill } from '../lib/downloadArtwork';
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
  }: {
    download: Download;
    title: Title;
    caption?: string;
    progress?: number;
    badge?: string;
    downloadBadge?: { state: 'queued' | 'downloading' | 'trouble' | 'ready'; label: string };
    href?: string;
    menu?: boolean;
  } = $props();

  let recoveredStill = $state<string>();
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
    const storedStill = download.title.stillPath;
    recoveredStill = storedStill;
    if (storedStill) return;
    let current = true;
    void downloadStill(download.title).then((still) => {
      if (current && artworkKey === key) recoveredStill = still;
    });
    return () => {
      current = false;
    };
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
/>
