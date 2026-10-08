<script lang="ts">
  import type { DownloadViewItem } from '../lib/libraryServiceProtocol';
  import type { Title } from '../lib/library';
  import PosterCard from './PosterCard.svelte';

  let {
    download,
    title,
    caption,
    progress,
    badge,
    downloadBadge,
    stillPath: recoveredStill,
    href,
    menu = true,
    active: _active = true,
  }: {
    download:
      DownloadViewItem | { title: { season?: number; episode?: number; stillPath?: string } };
    title: Title;
    caption?: string;
    progress?: number;
    badge?: string;
    downloadBadge?: { state: 'queued' | 'downloading' | 'trouble' | 'ready'; label: string };
    stillPath?: string;
    href?: string;
    menu?: boolean;
    active?: boolean;
  } = $props();

  const viewDownload = $derived('status' in download ? (download as DownloadViewItem) : undefined);
  const rowDownload = $derived(
    !viewDownload
      ? (download as { title: { season?: number; episode?: number; stillPath?: string } })
      : undefined,
  );
  const season = $derived(viewDownload?.season ?? rowDownload?.title.season);
  const episode = $derived(viewDownload?.episode ?? rowDownload?.title.episode);
  const stillPath = $derived(
    viewDownload?.stillPath ?? rowDownload?.title.stillPath ?? recoveredStill,
  );
  const coordinate = $derived(season === undefined ? undefined : `S${season} E${episode}`);
</script>

<PosterCard
  {title}
  {stillPath}
  landscape
  artCaption={coordinate}
  {badge}
  {downloadBadge}
  {caption}
  {progress}
  {href}
  {menu}
  checkAvailability={false}
/>
