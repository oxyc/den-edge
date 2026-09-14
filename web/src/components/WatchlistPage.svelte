<!-- The library as its own page — the TV's Watchlist tab (WatchlistView), taken further: Continue Watching as the TV
     row builds it, the watchlist split into series and movies, and everything watched as one long list, newest first,
     grouped by month and drawn a screenful at a time as you scroll. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { WatchedEntry } from '../lib/history';
  import type { ContinueEntry, Title } from '../lib/library';
  import PosterCard from './PosterCard.svelte';
  import PosterRow from './PosterRow.svelte';

  let {
    resume,
    saved,
    history,
    failure = null,
    onselect,
    ondismiss,
    onremove,
  }: {
    resume: ContinueEntry[];
    saved: Title[];
    history: WatchedEntry[];
    failure?: string | null;
    onselect: (title: Title) => void;
    /** Off Continue Watching until it's played again; absent where nothing can be written (a guest). */
    ondismiss?: (title: Title) => void;
    /** Out of the library, as the TV's Remove does. */
    onremove?: (title: Title) => void;
  } = $props();

  /** History cards drawn at once, and added each time the end of the list nears the screen. */
  const STEP = 48;
  let count = $state(STEP);
  let bottom = $state<HTMLElement>();

  $effect(() => {
    if (!bottom) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) count += STEP;
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(bottom);
    return () => observer.disconnect();
  });

  const key = (title: Title) => `${title.type}:${title.id}`;
  const series = $derived(saved.filter((t) => t.type === 'tv'));
  const movies = $derived(saved.filter((t) => t.type === 'movie'));

  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  /** The drawn part of the history, by the month it was watched in. */
  const months = $derived.by(() => {
    const groups: { key: string; label: string; entries: WatchedEntry[] }[] = [];
    for (const entry of history.slice(0, count)) {
      const date = new Date(entry.at);
      const month = `${date.getFullYear()}-${date.getMonth()}`;
      const last = groups.at(-1);
      if (last?.key === month) last.entries.push(entry);
      else groups.push({ key: month, label: monthName.format(date), entries: [entry] });
    }
    return groups;
  });

  function resumeCaption(entry: ContinueEntry): string | undefined {
    if (entry.episode) return `S${entry.episode.season} · E${entry.episode.episode}`;
    return entry.title.year ? String(entry.title.year) : undefined;
  }

  function watchedCaption(entry: WatchedEntry): string {
    const when = day.format(new Date(entry.at));
    return entry.episode ? `S${entry.episode.season} · E${entry.episode.episode} · ${when}` : when;
  }
</script>

{#snippet removable(
  title: Title,
  label: string,
  remove: ((title: Title) => void) | undefined,
  card: Snippet,
)}
  <div class="removable">
    {@render card()}
    {#if remove}
      <button
        type="button"
        class="remove"
        aria-label="{label} {title.title}"
        title={label}
        onclick={() => remove(title)}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
          ><path d="m6 6 12 12M18 6 6 18" /></svg
        >
      </button>
    {/if}
  </div>
{/snippet}

{#snippet grid(titles: Title[])}
  <div class="grid">
    {#each titles as title (key(title))}
      {#snippet card()}
        <PosterCard
          {title}
          caption={title.year ? String(title.year) : undefined}
          onselect={() => onselect(title)}
        />
      {/snippet}
      {@render removable(title, 'Remove from Watchlist', onremove, card)}
    {/each}
  </div>
{/snippet}

<h1>Watchlist</h1>
{#if failure}<p class="failure" role="alert">{failure}</p>{/if}

{#if !resume.length && !saved.length && !history.length}
  <p class="note">
    Nothing here yet. Add titles to your watchlist from their page, and what you watch on the TV or
    here shows up as you go.
  </p>
{/if}

{#if resume.length}
  <PosterRow heading="Continue Watching">
    {#each resume as entry (key(entry.title))}
      {#snippet card()}
        <PosterCard
          title={entry.title}
          caption={resumeCaption(entry)}
          progress={entry.fraction}
          onselect={() => onselect(entry.title)}
        />
      {/snippet}
      {@render removable(entry.title, 'Remove from Continue Watching', ondismiss, card)}
    {/each}
  </PosterRow>
{/if}

{#if series.length}
  <section aria-label="Watchlist series">
    <h2>Series <span class="count">{series.length}</span></h2>
    {@render grid(series)}
  </section>
{/if}
{#if movies.length}
  <section aria-label="Watchlist movies">
    <h2>Movies <span class="count">{movies.length}</span></h2>
    {@render grid(movies)}
  </section>
{/if}

{#if history.length}
  <section aria-label="Watched">
    <h2>Watched <span class="count">{history.length}</span></h2>
    {#each months as month (month.key)}
      <h3>{month.label}</h3>
      <div class="grid">
        {#each month.entries as entry (key(entry.title))}
          <PosterCard
            title={entry.title}
            caption={watchedCaption(entry)}
            onselect={() => onselect(entry.title)}
          />
        {/each}
      </div>
    {/each}
    <div bind:this={bottom} class="bottom" aria-hidden="true"></div>
  </section>
{/if}

<style>
  h1 {
    margin: 0 0 24px;
    font-size: 28px;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 20px;
  }

  h3 {
    margin: 8px 0 12px;
    color: var(--muted);
    font-size: 15px;
    font-weight: 600;
  }

  .count {
    margin-left: 6px;
    color: var(--muted);
    font-size: 15px;
    font-weight: 500;
  }

  .note {
    color: var(--muted);
  }

  .failure {
    color: var(--danger);
  }

  section {
    margin-bottom: 32px;
  }

  /* Search's grid (SearchResults), so a page of posters looks the same wherever it is. */
  .grid {
    --card-w: 100%;

    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(120px, 28vw, 170px), 1fr));
    gap: 20px 14px;
    margin-bottom: 24px;
  }

  .removable {
    position: relative;
  }

  .remove {
    position: absolute;
    top: 8px;
    right: 8px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    color: var(--fg);
    cursor: pointer;
  }

  .remove svg {
    fill: none;
    stroke: currentcolor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  /* Out of the way until the card is pointed at, where there is a pointer to point with; always there on touch. */
  @media (hover: hover) {
    .remove {
      opacity: 0;
    }

    .remove:focus-visible {
      opacity: 1;
    }

    .removable:hover .remove {
      opacity: 1;
    }
  }

  .bottom {
    height: 1px;
  }
</style>
