<script lang="ts">
  import DetailIcon from './DetailIcon.svelte';
  import ActionMenu from './ActionMenu.svelte';
  import { downloadSeason, type SeasonJob, type SeasonTitle } from '../lib/seasonDownloads.svelte';
  import type { Episode } from '../lib/detail';
  import type { LibraryModel } from '../lib/libraryModel.svelte';
  import type { MenuItem } from '../lib/titleActions';
  let {
    title,
    imdb,
    season,
    episodes,
    disabled = false,
    compact = false,
    choices = [],
    episodesFor,
    model,
    allowed = async () => true,
  }: {
    /** The series, as each episode's download is written down for every device to show. */
    title: SeasonTitle;
    imdb: string;
    season: number;
    episodes?: Episode[];
    disabled?: boolean;
    /** Beside the season tabs: the icon alone, since the tab it sits next to already says which season. */
    compact?: boolean;
    /** TV detail actions ask which season explicitly instead of inheriting the focused episode tab. */
    choices?: { number: number; name: string }[];
    episodesFor?: (season: number, signal: AbortSignal) => Promise<Episode[] | null>;
    model: LibraryModel;
    /** The active profile's policy check, asked again where the download starts. */
    allowed?: () => Promise<boolean>;
  } = $props();
  let job = $state<SeasonJob>();
  let jobSeason = $state(0);
  let loadingSeason = $state<number>();
  let failure = $state('');
  let observer: AbortController | undefined;
  $effect(() => {
    void `${title.id}:${imdb}:${season}`;
    return () => observer?.abort();
  });
  async function start(target = season) {
    if (!(await allowed())) return;
    observer?.abort();
    observer = new AbortController();
    job = undefined;
    jobSeason = target;
    loadingSeason = target;
    failure = '';
    const selectedEpisodes =
      target === season && episodes ? episodes : await episodesFor?.(target, observer.signal);
    if (observer.signal.aborted) return;
    loadingSeason = undefined;
    if (!selectedEpisodes) {
      failure = `Couldn’t load season ${target}. Try again.`;
      return;
    }
    void downloadSeason(
      model,
      imdb,
      target,
      selectedEpisodes,
      title,
      (next) => (job = next),
      observer.signal,
    ).catch(() => {
      if (!observer?.signal.aborted && job) job = { ...job, running: false };
    });
  }
  const label = $derived(choices.length ? 'Download a season' : `Download season ${season}`);
  /**
   * While running, the visible progress IS the name — "Preparing season 2: 3 of 12" — so an `aria-label`
   * doesn't shadow it (the name must contain the visible text, WCAG 2.5.3). Idle and compact, there is no
   * visible text at all (the icon stands for "download", the tab beside it already says which season), so
   * that's the one case this still needs one.
   */
  const running = $derived(
    `Preparing season ${jobSeason}: ${job?.checked ?? 0} of ${job?.total ?? 0}`,
  );
  const pickerItems = $derived<MenuItem[]>(
    choices.map(({ number, name }) => ({
      kind: 'item',
      label: name,
      disabled: disabled || loadingSeason !== undefined || job?.running,
      onselect: () => void start(number),
    })),
  );
</script>

<div class="download" class:compact class:picker={choices.length > 0}>
  {#if choices.length}
    <ActionMenu
      items={pickerItems}
      label={job?.running ? running : loadingSeason ? `Loading season ${loadingSeason}` : label}
      heading="Download"
      triggerClass="den-button den-button-secondary den-button-large season-download-trigger"
      glyph={downloadLabel}
    />
  {:else}
    <button
      disabled={disabled || loadingSeason !== undefined || job?.running}
      aria-label={compact && !job?.running ? label : undefined}
      title={job?.running ? undefined : label}
      onclick={() => void start()}
    >
      <DetailIcon name="download" />{#if job?.running}{running}{:else if !compact}Download season {season}{/if}
    </button>
  {/if}
  {#if job && !job.running}<p role="status">
      {job.queued} queued · {job.ready} already ready{job.searching
        ? ` · ${job.searching} searching for a release`
        : ''}{job.waiting ? ` · ${job.waiting} waiting to air` : ''}{job.uncertain
        ? ` · ${job.uncertain} unconfirmed`
        : ''}
    </p>{:else if failure}<p role="status">{failure}</p>{/if}
</div>

{#snippet downloadLabel()}
  <DetailIcon name="download" /><span>{job?.running ? running : 'Download'}</span>
{/snippet}

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
    outline: var(--ring-width) solid var(--focus-ring);
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

  /* A labelled season picker is one peer in an action row, not the standalone compact control below episode tabs. */
  .picker {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    margin: 0;
  }

  .download :global(.season-download-trigger) {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    width: auto;
    min-width: max-content;
    padding: 0 22px;
    border: 1px solid rgb(255 255 255 / 0.14);
    background: rgb(255 255 255 / 0.08);
    font-weight: 600;
    white-space: nowrap;
  }

  /* Beside the tabs it reads as a mark on the row, not a second control competing with them: no plate, no
     border, just the icon. The 44px target and the focus ring stay — only the resting chrome goes. */
  .compact button {
    padding: 8px;
    border: 0;
    background: none;
    color: var(--muted);
  }

  :global(.season-download-trigger[aria-expanded='true']) {
    border-color: var(--fg);
  }

  .compact button:focus-visible {
    color: var(--fg);
  }

  .compact button:hover:not(:disabled) {
    color: var(--fg);
  }
</style>
