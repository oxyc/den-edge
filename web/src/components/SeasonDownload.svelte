<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import { downloadSeason, type SeasonJob, type SeasonTitle } from '../lib/seasonDownloads.svelte';
  import type { Episode } from '../lib/detail';
  import type { Addon } from '../lib/scout';
  import type { Routes } from '../lib/routes';
  import type { LibraryModel } from '../lib/libraryModel.svelte';
  let {
    scout: _scout,
    title,
    imdb,
    season,
    episodes,
    routes: _routes,
    disabled = false,
    compact = false,
    model,
  }: {
    scout: Addon;
    /** The series, as each episode's download is written down for every device to show. */
    title: SeasonTitle;
    imdb: string;
    season: number;
    episodes: Episode[];
    routes: Routes;
    disabled?: boolean;
    /** Beside the season tabs: the icon alone, since the tab it sits next to already says which season. */
    compact?: boolean;
    /** Detail supplies this during the final LibraryModel integration. */
    model?: LibraryModel;
  } = $props();
  let job = $state<SeasonJob>();
  const label = $derived(`Download season ${season}`);
  /**
   * While running, the visible progress IS the name — "Preparing season 2: 3 of 12" — so an `aria-label`
   * doesn't shadow it (the name must contain the visible text, WCAG 2.5.3). Idle and compact, there is no
   * visible text at all (the icon stands for "download", the tab beside it already says which season), so
   * that's the one case this still needs one.
   */
  const running = $derived(
    `Preparing season ${season}: ${job?.checked ?? 0} of ${job?.total ?? 0}`,
  );
</script>

<div class="download" class:compact>
  <button
    disabled={disabled || !model || job?.running}
    aria-label={compact && !job?.running ? label : undefined}
    title={job?.running ? undefined : label}
    onclick={() =>
      model && void downloadSeason(model, imdb, season, episodes, title, (next) => (job = next))}
  >
    <DetailIcon name="download" />{#if job?.running}{running}{:else if !compact}Download season {season}{/if}
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
