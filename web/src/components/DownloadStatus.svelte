<!-- What one download is doing, as every surface that shows one says it (the TV's download card): what the debrid is
     doing and how fast, then the figures behind it, then which release, and who queued it when that wasn't this
     browser. Text, not controls: it is a status. -->
<script lang="ts">
  import { downloads as shared, type DownloadQueue } from '../lib/downloadQueue.svelte';
  import { deviceName, type Download } from '../lib/downloadRows';
  import { facts, headline, isTrouble, queuedFrom, releaseLine } from '../lib/downloadStatus';

  let {
    download,
    queue = shared,
    now = Date.now(),
    release = true,
  }: {
    download: Download;
    queue?: DownloadQueue;
    now?: number;
    /** Name the release too: off where the release is already on screen (a title's source list). */
    release?: boolean;
  } = $props();

  const status = $derived(queue.status(download, now));
  const answer = $derived(queue.answers.get(download.name));
  const lines = $derived(facts(download, status, answer, now));
  const from = $derived(
    queuedFrom(download, queue.device, (device) =>
      deviceName(queue.library?.settings('devices'), device),
    ),
  );
</script>

<div class="download-status">
  <p class="headline" class:trouble={isTrouble(status, answer)} role="status">
    {headline(status, answer)}
  </p>
  {#if lines.length}<p>{lines.join(' · ')}</p>{/if}
  {#if release && releaseLine(download)}<p class="release">{releaseLine(download)}</p>{/if}
  {#if download.release.hedge}
    <p class="alternate">Also trying {download.release.hedge.label ?? 'another release'}</p>
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
