<!-- What one download is doing, as every surface that shows one says it (the TV's download card): what the debrid is
     doing and how fast, then the figures behind it, then which release, and who queued it when that wasn't this
     browser. Text, not controls: it is a status. -->
<script lang="ts">
  import type { DownloadViewItem } from '../lib/libraryServiceProtocol';
  import { viewFacts, viewHeadline, viewTrouble } from '../lib/downloadStatus';

  let {
    download,
    now = Date.now(),
    release = true,
  }: {
    download: DownloadViewItem;
    now?: number;
    /** Name the release too: off where the release is already on screen (a title's source list). */
    release?: boolean;
  } = $props();

  const lines = $derived(viewFacts(download, now));
  const from = $derived(
    download.queuedBy.isSelf
      ? undefined
      : `Queued from ${download.queuedBy.name ?? 'another device'}`,
  );
</script>

<div class="download-status">
  <p class="headline" class:trouble={viewTrouble(download)} role="status">
    {viewHeadline(download)}
  </p>
  {#if lines.length}<p>{lines.join(' · ')}</p>{/if}
  {#if release}<p class="release">{download.release.label}</p>{/if}
  {#if download.alternate}
    <p class="alternate">Also trying {download.alternate.label}</p>
  {/if}
  {#if from}<p class="from">{from}</p>{/if}
</div>

<style>
  .download-status p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .download-status .headline {
    color: var(--fg);
  }

  .download-status .headline.trouble {
    color: #ffc177;
  }

  .download-status .release,
  .download-status .alternate,
  .download-status .from {
    font-size: 12px;
  }
</style>
