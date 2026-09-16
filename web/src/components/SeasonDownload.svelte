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
    compact = false,
  }: {
    scout: Addon;
    imdb: string;
    season: number;
    episodes: Episode[];
    routes: Routes;
    disabled?: boolean;
    /** Beside the season tabs: the icon alone, since the tab it sits next to already says which season. */
    compact?: boolean;
  } = $props();
  const job = $derived(seasonJobs.get(seasonJobKey(scout, imdb, season)));
  // Always spoken in full, however little is drawn: "Download" alone would not say what is downloaded.
  const label = $derived(`Download season ${season}`);
</script>

<div class="download" class:compact>
  <button
    disabled={disabled || job?.running}
    aria-label={label}
    title={label}
    onclick={() => void downloadSeason(scout, imdb, season, episodes, routes)}
  >
    <DetailIcon name="download" />{#if job?.running}Preparing {job.checked} of {job.total}{:else if !compact}Download
      season{/if}
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

  /* In the season bar it is one control among the tabs, so it carries no margin of its own. */
  .compact {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
  }

  /* Beside the tabs it reads as a mark on the row, not a second control competing with them: no plate, no
     border, just the icon. The 44px target and the focus ring stay — only the resting chrome goes. */
  .compact button {
    padding: 8px;
    border: 0;
    background: none;
    color: var(--muted);
  }

  .compact button:focus-visible {
    color: var(--fg);
  }

  .compact button:hover:not(:disabled) {
    color: var(--fg);
  }
</style>
