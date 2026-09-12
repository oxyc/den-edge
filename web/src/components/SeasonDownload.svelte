<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import { downloadSeason, seasonJobs, seasonJobKey } from '../lib/seasonDownloads.svelte';
  import type { Episode } from '../lib/detail';
  import type { Addon } from '../lib/scout';
  import type { Routes } from '../lib/routes';
  let {
    scout,
    imdb,
    season,
    episodes,
    routes,
    disabled = false,
  }: {
    scout: Addon;
    imdb: string;
    season: number;
    episodes: Episode[];
    routes: Routes;
    disabled?: boolean;
  } = $props();
  const job = $derived(seasonJobs.get(seasonJobKey(scout, imdb, season)));
</script>

<div class="download">
  <button
    disabled={disabled || job?.running}
    onclick={() => void downloadSeason(scout, imdb, season, episodes, routes)}
  >
    <DetailIcon name="download" />{job?.running
      ? `Preparing ${job.checked} of ${job.total}`
      : 'Download season'}
  </button>
  {#if job && !job.running}<p role="status">
      {job.queued} queued · {job.ready} already ready{job.unavailable
        ? ` · ${job.unavailable} unavailable`
        : ''}{job.uncertain ? ` · ${job.uncertain} unconfirmed` : ''}
    </p>{/if}
</div>

<style>
  .download {
    margin: 20px 0;
  }

  button {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 8px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    color: var(--fg);
    background: #ffffff0c;
    cursor: pointer;
  }

  button:disabled {
    color: var(--muted);
    cursor: default;
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  p {
    font-size: 13px;
    color: var(--muted);
  }
</style>
