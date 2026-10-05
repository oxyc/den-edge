<!-- Everything the household has asked the debrid to fetch, from any device (den-spec library-v4 §17): the TV's
     Downloads shelf as a page. Each card is the title's poster with how far it has got; under it, what the debrid is
     doing, and Cancel (in flight: dropped at the debrid too) or Remove (only the card). -->
<script lang="ts">
  import { untrack } from 'svelte';
  import DownloadStatus from './DownloadStatus.svelte';
  import DownloadAlternatives from './DownloadAlternatives.svelte';
  import DownloadPosterCard from './DownloadPosterCard.svelte';
  import { downloads as shared, inFlight, type DownloadQueue } from '../lib/downloadQueue.svelte';
  import type { Download } from '../lib/downloadRows';
  import { headline, phase } from '../lib/downloadStatus';
  import type { Title } from '../lib/library';
  import { titleHref } from '../lib/route';

  let { queue = shared, active = true }: { queue?: DownloadQueue; active?: boolean } = $props();

  /** The clock the status lines read, ticked while the page is showing so "No progress for 14 min" keeps time. */
  let now = $state(Date.now());
  $effect(() => {
    if (!active) return;
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const list = $derived(queue.list());
  /** Asked once as the page shows, then by the library's own refresh: it opens on fresh figures. */
  $effect(() => {
    if (!active) return;
    untrack(() => {
      for (const download of queue.list()) void queue.poll(download);
    });
  });
  let busy = $state<string | null>(null);

  const titleOf = (download: Download): Title => ({
    type: download.title.mediaType,
    id: download.title.mediaId,
    title: download.title.title || download.release.label,
    posterPath: download.title.posterPath,
  });

  async function drop(download: Download) {
    busy = download.name;
    try {
      await queue.remove(download, inFlight(queue.status(download).state));
    } finally {
      busy = null;
    }
  }
</script>

<h1>Downloads</h1>
<p class="note">Your debrid fetches these — you can close Den, they keep going.</p>

{#if !list.length}
  <p class="note">Nothing downloading. Download a title from its Sources to see it here.</p>
{:else}
  <ul class="grid">
    {#each list as download (download.name)}
      {@const status = queue.status(download, now)}
      {@const state = status.state}
      {@const answer = queue.answers.get(download.name)}
      <li data-download={download.content}>
        <DownloadPosterCard
          {download}
          title={titleOf(download)}
          badge={answer?.state === 'preparing' && answer.progress
            ? `${Math.floor(Math.min(answer.progress, 1) * 100)}%`
            : undefined}
          progress={state === 'ready'
            ? 1
            : answer?.state === 'preparing'
              ? answer.progress
              : undefined}
          downloadBadge={{ state: phase(status, answer), label: headline(status, answer) }}
          href={titleHref(titleOf(download))}
          menu={false}
        />
        <DownloadStatus {download} {queue} {now} />
        {#if state !== 'ready'}<DownloadAlternatives {download} {queue} />{/if}
        <button
          type="button"
          class="control"
          disabled={busy === download.name}
          onclick={() => void drop(download)}
          >{inFlight(state) ? 'Cancel download' : 'Remove'}</button
        >
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    margin: 0 0 8px;
    font-size: 28px;
  }

  .note {
    margin: 0 0 24px;
    color: var(--muted);
  }

  /* Search's and the Watchlist's grid, so a page of posters looks the same wherever it is. */
  .grid {
    /* PosterCard widens a landscape row card by 1.45× relative to the portrait rhythm. Here the grid track is
       already the final card width, so compensate instead of overflowing a phone viewport. */
    --card-w: calc(100% / 1.45);

    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(220px, 70vw, 300px), 1fr));
    gap: 24px 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
  }

  .control {
    justify-self: start;
    min-height: 36px;
    margin-top: 4px;
    padding: 6px 14px;
    border: 1px solid #ffffff24;
    border-radius: 999px;
    background: #ffffff15;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
  }

  .control:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .control:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
</style>
