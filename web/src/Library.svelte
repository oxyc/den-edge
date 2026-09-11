<script lang="ts">
  import PosterCard from './components/PosterCard.svelte';
  import PosterRow from './components/PosterRow.svelte';
  import SearchResults from './components/SearchResults.svelte';
  import TitleSheet from './components/TitleSheet.svelte';
  import { searchStream, type Hit } from './lib/search';
  import { searchSources } from './lib/searchSources';
  import { addToWatchlist, blankTitle, markWatched, react, removeFromLibrary, unwatch } from './lib/actions';
  import { loadLibrary, type LibraryResult } from './lib/backup';
  import { browserClock } from './lib/clock';
  import {
    applyLog,
    continueWatching,
    untitled,
    watchlist,
    withDisplay,
    type ContinueEntry,
    type Title,
  } from './lib/library';
  import type { Link } from './lib/links.svelte';
  import { LibraryLog } from './lib/log';
  import { fetchTitle, storedTmdbKey } from './lib/tmdb';
  import type { Stamp, TitleRow } from './lib/wire';

  let { link }: { link: Link } = $props();

  interface Loaded {
    result: LibraryResult;
    /** The record log, when the TV has handed over its key — reading it and writing to it. */
    log: LibraryLog | null;
  }

  const tmdbKey = storedTmdbKey();
  const clock = browserClock();
  let loaded = $state<Loaded | null>(null);
  /** TMDB display for titles the log names without it, and for titles acted on here. */
  let displays = $state<Title[]>([]);
  /** Bumped after a write: the log isn't reactive, so the rows re-derive from it on this. */
  let version = $state(0);
  let selected = $state<Title | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  $effect(() => {
    void load(link.inboxKey).then((l) => (loaded = l));
  });

  /** The backup, brought up to date from the record log when the TV has handed over its key. */
  async function load(inboxKey: string): Promise<Loaded> {
    const result = await loadLibrary(inboxKey);
    if (result.state !== 'ok' || !result.libraryKey) return { result, log: null };
    const log = await LibraryLog.open(result.libraryKey);
    if (!log) return { result, log: null };
    clock.see(log.newestStamp());
    if (tmdbKey) {
      const library = applyLog(result.library, log.rows());
      const titles = await Promise.all(untitled(library).slice(0, 60).map((ref) => fetchTitle(ref, tmdbKey)));
      displays = titles.filter((t): t is Title => t !== null);
    }
    return { result: { ...result, live: true }, log };
  }

  const library = $derived.by(() => {
    void version;
    if (loaded?.result.state !== 'ok') return null;
    const base = loaded.log ? applyLog(loaded.result.library, loaded.log.rows()) : loaded.result.library;
    return withDisplay(base, displays);
  });

  const selectedRow = $derived.by(() => {
    void version;
    return selected ? loaded?.log?.title(selected) : undefined;
  });

  /** Apply an action to the title's row as last read (or a blank one), stamped now, and write it. */
  async function act(title: Title, change: (row: TitleRow, at: Stamp) => TitleRow) {
    const log = loaded?.log;
    if (!log) return;
    if (!displays.some((d) => d.type === title.type && d.id === title.id)) displays = [...displays, title];
    busy = true;
    failure = null;
    const saved = await log.write(change(log.title(title) ?? blankTitle(title, Date.now()), clock.issue()));
    busy = false;
    if (!saved) failure = 'Couldn’t save that. Check that this device is on your network.';
    version++;
  }

  const select = $derived(loaded?.log ? (title: Title) => (selected = title) : undefined);

  // Search, as the TV's Search tab runs it: a pause after typing, then results that improve as sources answer;
  // a newer query supersedes an older one mid-flight.
  const sources = tmdbKey ? searchSources(tmdbKey) : null;
  let query = $state('');
  let hits = $state<Hit[] | null>(null);
  let searchFailed = $state(false);
  let generation = 0;
  let pause: ReturnType<typeof setTimeout> | undefined;

  function queryChanged() {
    clearTimeout(pause);
    generation++;
    const text = query.trim();
    if (text.length < 2 || !sources) {
      hits = null;
      return;
    }
    pause = setTimeout(() => void runSearch(text, generation), 300);
  }

  async function runSearch(text: string, ticket: number) {
    if (!sources) return;
    searchFailed = false;
    let painted = false;
    try {
      for await (const batch of searchStream(text, sources)) {
        if (ticket !== generation) return;
        hits = batch;
        painted = true;
      }
      if (!painted && ticket === generation) hits = [];
    } catch {
      if (ticket === generation) {
        searchFailed = true;
        hits = [];
      }
    }
  }

  function caption(entry: ContinueEntry): string | undefined {
    if (entry.episode) return `S${entry.episode.season} · E${entry.episode.episode}`;
    return entry.title.year ? String(entry.title.year) : undefined;
  }
</script>

{#if !loaded}
  <p class="note">Loading your library…</p>
{:else if loaded.result.state === 'ok' && library}
  {@const resume = continueWatching(library)}
  {@const saved = watchlist(library)}
  {#if sources}
    <input
      class="search glass"
      type="search"
      placeholder="Search movies, series and people"
      aria-label="Search movies, series and people"
      autocomplete="off"
      bind:value={query}
      oninput={queryChanged}
    />
  {/if}
  {#if hits}
    {#if hits.length}
      <SearchResults {hits} onselect={select} />
    {:else}
      <p class="note">{searchFailed ? 'Couldn’t search right now. Try again in a moment.' : 'No matches.'}</p>
    {/if}
  {:else if resume.length}
    <PosterRow heading="Continue Watching">
      {#each resume as entry (`${entry.title.type}:${entry.title.id}`)}
        <PosterCard
          title={entry.title}
          caption={caption(entry)}
          progress={entry.fraction}
          onselect={select && (() => select(entry.title))}
        />
      {/each}
    </PosterRow>
  {/if}
  {#if !hits && saved.length}
    <PosterRow heading="Watchlist">
      {#each saved as title (`${title.type}:${title.id}`)}
        <PosterCard
          {title}
          caption={title.year ? String(title.year) : undefined}
          onselect={select && (() => select(title))}
        />
      {/each}
    </PosterRow>
  {/if}
  {#if !hits && !resume.length && !saved.length}
    <p class="note">Nothing in progress and nothing on your watchlist yet.</p>
  {/if}
  {#if loaded.result.live}
    <p class="note small">Up to date with your TV.</p>
  {:else}
    <p class="note small">From the TV’s backup of {new Date(loaded.result.backedUpAt).toLocaleString()}.</p>
  {/if}
{:else if loaded.result.state === 'none'}
  <p class="note">No backup from your TV yet. On the TV, open <b>Settings › Sync settings</b> and back up.</p>
{:else if loaded.result.state === 'error' && loaded.result.reason === 'unreadable'}
  <p class="note">The backup here was made with another link. Back up again on the TV.</p>
{:else}
  <p class="note">Couldn’t reach Den. Check that this device is on your network.</p>
{/if}

{#if selected}
  {@const title = selected}
  <TitleSheet
    {title}
    row={selectedRow}
    {busy}
    {failure}
    onclose={() => {
      selected = null;
      failure = null;
    }}
    onwatchlist={(on) => act(title, on ? addToWatchlist : removeFromLibrary)}
    onseen={(on) => act(title, on ? markWatched : unwatch)}
    onreact={(reaction) => act(title, (row, at) => react(row, reaction, at))}
  />
{/if}

<style>
  .search {
    width: 100%;
    margin-bottom: 28px;
    padding: 12px 20px;
    border-radius: 999px;
    color: var(--fg);
    outline: none;
  }

  .search:focus-visible {
    border-color: var(--accent);
  }

  .note {
    color: var(--muted);
  }

  .small {
    font-size: 13px;
  }
</style>
