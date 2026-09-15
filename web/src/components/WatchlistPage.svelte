<!-- The library as its own page — the TV's Watchlist tab (WatchlistView), taken further: Continue Watching as the TV
     row builds it, the watchlist under the same three tabs Watched uses, everything watched as one long list, newest first,
     grouped by month and drawn a screenful at a time as you scroll. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { airedEpisodes, seenAired, type SeenEpisode, type WatchedEntry } from '../lib/history';
  import type { ContinueEntry, MediaType, Shape, Title } from '../lib/library';
  import { titleHref } from '../lib/route';
  import PosterCard from './PosterCard.svelte';
  import PosterRow from './PosterRow.svelte';

  let {
    resume,
    saved,
    history,
    shapes,
    seen,
    failure = null,
    ondismiss,
    onremove,
    onseen,
  }: {
    resume: ContinueEntry[];
    saved: Title[];
    history: WatchedEntry[];
    /** Each series' season layout, by `type:id`, for how many of its episodes have aired. */
    shapes: ReadonlyMap<string, Shape>;
    /** Each series' seen episodes, by `type:id`. */
    seen: ReadonlyMap<string, readonly SeenEpisode[]>;
    failure?: string | null;
    /** Off Continue Watching until it's played again; absent where nothing can be written (a guest). */
    ondismiss?: (title: Title) => void;
    /** Out of the library, as the TV's Remove does. */
    onremove?: (title: Title) => void;
    /** Seen or not, as the title page's Seen button does it: a series with every aired episode. */
    onseen?: (title: Title, seen: boolean) => void;
  } = $props();

  type Control = {
    label: string;
    icon: 'remove' | 'seen' | 'unseen';
    run: (title: Title) => void;
    /** Asked first, on the same button, when the change undoes more than the card shows. */
    confirm?: string;
  };

  /** History cards drawn at once, and added each time the end of the list nears the screen. */
  const STEP = 48;
  /** How long a question waits for its second press before the button goes back to what it was. */
  const ASK_FOR = 5000;
  let count = $state(STEP);
  let bottom = $state<HTMLElement>();
  const FILTERS: { value: MediaType | null; label: string }[] = [
    { value: null, label: 'All' },
    { value: 'movie', label: 'Movies' },
    { value: 'tv', label: 'Series' },
  ];
  let kind = $state<MediaType | null>(null);
  /** The same three tabs over the watchlist. It was two headed sections, which read as two different things. */
  let savedKind = $state<MediaType | null>(null);
  /** The control waiting for its second press, by control and title, and the question it asks. */
  let confirming = $state<{ id: string; question: string } | null>(null);

  const key = (title: Title) => `${title.type}:${title.id}`;
  // A series with an episode seen is under way: it's in Continue Watching or Watched, so the watchlist doesn't also
  // offer to mark it watched.
  const listed = $derived(saved.filter((t) => !seen.get(key(t))?.length));
  const savedShown = $derived(savedKind ? listed.filter((t) => t.type === savedKind) : listed);
  const shown = $derived(kind ? history.filter((e) => e.title.type === kind) : history);

  // Observed again after each step: one step that doesn't reach past the screen — a very wide one — fires nothing
  // more on its own, so the list would stop there.
  $effect(() => {
    if (!bottom || count >= shown.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) count += STEP;
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(bottom);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => (confirming = null), ASK_FOR);
    return () => clearTimeout(timer);
  });

  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  /** The drawn part of the history, by the month it was watched in; a watch with no time goes under Earlier. */
  const months = $derived.by(() => {
    const groups: { key: string; label: string; entries: WatchedEntry[] }[] = [];
    for (const entry of shown.slice(0, count)) {
      const date = new Date(entry.at);
      const [month, label] =
        entry.at > 0
          ? [`${date.getFullYear()}-${date.getMonth()}`, monthName.format(date)]
          : ['earlier', 'Earlier'];
      const last = groups.at(-1);
      if (last?.key === month) last.entries.push(entry);
      else groups.push({ key: month, label, entries: [entry] });
    }
    return groups;
  });

  /** A series' seen episodes against those aired — "4 of 10 episodes" — and how far that is; none before any is seen. */
  function progressOf(title: Title): { text: string; fraction?: number } | undefined {
    const episodes = title.type === 'tv' ? seen.get(key(title)) : undefined;
    if (!episodes?.length) return undefined;
    const shape = shapes.get(key(title));
    const counted = seenAired(episodes, shape);
    const aired = shape ? airedEpisodes(shape) : 0;
    if (!aired)
      return counted ? { text: `${counted} episode${counted === 1 ? '' : 's'}` } : undefined;
    return { text: `${counted} of ${aired} episodes`, fraction: counted / aired };
  }

  function resumeCaption(entry: ContinueEntry): string | undefined {
    if (entry.episode) return `S${entry.episode.season} · E${entry.episode.episode}`;
    return entry.title.year ? String(entry.title.year) : undefined;
  }

  function watchedCaption(entry: WatchedEntry): string | undefined {
    const parts = [
      progressOf(entry.title)?.text ??
        (entry.episode ? `S${entry.episode.season} · E${entry.episode.episode}` : undefined),
      entry.at > 0 ? day.format(new Date(entry.at)) : undefined,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : undefined;
  }

  function press(control: Control, title: Title) {
    const id = `${control.icon}:${key(title)}`;
    if (control.confirm && confirming?.id !== id) {
      confirming = { id, question: `${control.confirm} ${title.title}` };
      return;
    }
    confirming = null;
    control.run(title);
  }

  /** A press anywhere but on the question, or Escape, takes the question back. */
  function dismissQuestion(event: Event) {
    if (!confirming) return;
    if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
    if (event.target instanceof Element && event.target.closest('[data-asking]')) return;
    confirming = null;
  }

  const savedControls = $derived<Control[]>([
    ...(onseen
      ? [{ label: 'Mark watched', icon: 'seen' as const, run: (t: Title) => onseen(t, true) }]
      : []),
    ...(onremove
      ? [{ label: 'Remove from Watchlist', icon: 'remove' as const, run: onremove }]
      : []),
  ]);
  const resumeControls = $derived<Control[]>(
    ondismiss
      ? [{ label: 'Remove from Continue Watching', icon: 'remove' as const, run: ondismiss }]
      : [],
  );
  function watchedControls(entry: WatchedEntry): Control[] {
    if (!onseen) return [];
    return [
      {
        label: 'Mark unwatched',
        icon: 'unseen',
        run: (t) => onseen(t, false),
        // A series comes off with every one of its episodes, which no single card shows.
        confirm: entry.title.type === 'tv' ? 'Unmark all episodes?' : undefined,
      },
    ];
  }
</script>

<svelte:window onpointerdown={dismissQuestion} onkeydown={dismissQuestion} />

{#snippet framed(title: Title, controls: Control[], card: Snippet)}
  <div class="framed">
    {@render card()}
    {#if controls.length}
      <div class="controls">
        {#each controls as control (control.icon)}
          {@const asking = confirming?.id === `${control.icon}:${key(title)}`}
          <button
            type="button"
            class="control"
            class:asking
            data-asking={asking || undefined}
            aria-label={asking && control.confirm
              ? `${control.confirm} ${title.title}`
              : `${control.label} ${title.title}`}
            title={asking ? control.confirm : control.label}
            onclick={() => press(control, title)}
          >
            {#if asking}
              <span class="ask">{control.confirm}</span>
            {:else}
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                {#if control.icon === 'remove'}
                  <path d="m6 6 12 12M18 6 6 18" />
                {:else if control.icon === 'seen'}
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                {:else}
                  <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
                  <path d="m4 4 16 16" />
                {/if}
              </svg>
            {/if}
          </button>
        {/each}
      </div>
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
          href={titleHref(title)}
        />
      {/snippet}
      {@render framed(title, savedControls, card)}
    {/each}
  </div>
{/snippet}

<h1>Watchlist</h1>
{#if failure}<p class="failure" role="alert">{failure}</p>{/if}
<p class="visually-hidden" aria-live="polite">{confirming?.question ?? ''}</p>

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
          href={titleHref(entry.title)}
        />
      {/snippet}
      {@render framed(entry.title, resumeControls, card)}
    {/each}
  </PosterRow>
{/if}

{#if listed.length}
  <section aria-label="Watchlist">
    <div class="heading">
      <h2>Watchlist <span class="count">{savedShown.length}</span></h2>
      <div class="filter" role="group" aria-label="Show in Watchlist">
        {#each FILTERS as filter (filter.label)}
          <button
            type="button"
            aria-pressed={savedKind === filter.value}
            onclick={() => (savedKind = filter.value)}>{filter.label}</button
          >
        {/each}
      </div>
    </div>
    {@render grid(savedShown)}
    {#if !savedShown.length}
      <p class="note">Nothing of these on your watchlist.</p>
    {/if}
  </section>
{/if}

{#if history.length}
  <section aria-label="Watched">
    <div class="heading">
      <h2>Watched <span class="count">{shown.length}</span></h2>
      <div class="filter" role="group" aria-label="Show in Watched">
        {#each FILTERS as filter (filter.label)}
          <button
            type="button"
            aria-pressed={kind === filter.value}
            onclick={() => {
              kind = filter.value;
              // A different filter starts the list from its top again.
              count = STEP;
            }}>{filter.label}</button
          >
        {/each}
      </div>
    </div>
    {#each months as month (month.key)}
      <h3>{month.label}</h3>
      <div class="grid">
        {#each month.entries as entry (key(entry.title))}
          {#snippet card()}
            <PosterCard
              title={entry.title}
              caption={watchedCaption(entry)}
              progress={progressOf(entry.title)?.fraction}
              href={titleHref(entry.title)}
            />
          {/snippet}
          {@render framed(entry.title, watchedControls(entry), card)}
        {/each}
      </div>
    {/each}
    {#if !shown.length}
      <p class="note">Nothing watched of these yet.</p>
    {/if}
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

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  section {
    margin-bottom: 32px;
  }

  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-bottom: 12px;
  }

  .heading h2 {
    margin: 0;
  }

  .filter {
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 999px;
    background: var(--card);
  }

  .filter button {
    min-height: 30px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .filter button[aria-pressed='true'] {
    background: rgb(255 255 255 / 0.14);
    color: var(--fg);
  }

  /* Search's grid (SearchResults), so a page of posters looks the same wherever it is. */
  .grid {
    --card-w: 100%;

    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(120px, 28vw, 170px), 1fr));
    gap: 20px 14px;
    margin-bottom: 24px;
  }

  .framed {
    position: relative;
  }

  .controls {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 6px;
  }

  .control {
    display: grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
    color: var(--fg);
    cursor: pointer;
  }

  .control.asking {
    padding: 0 10px;
    background: var(--danger);
  }

  .ask {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .control svg {
    fill: none;
    stroke: currentcolor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Out of the way until the card is pointed at, where there is a pointer to point with; always there on touch. While
     hidden they take no clicks, so a tap on a poster's corner can't remove what nobody could see. */
  @media (hover: hover) {
    .controls {
      opacity: 0;
      pointer-events: none;
    }

    .controls:focus-within {
      opacity: 1;
      pointer-events: auto;
    }

    .framed:hover .controls {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .bottom {
    height: 1px;
  }
</style>
