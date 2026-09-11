<script lang="ts">
  import PosterCard from './components/PosterCard.svelte';
  import PosterRow from './components/PosterRow.svelte';
  import SearchResults from './components/SearchResults.svelte';
  import TitleSheet from './components/TitleSheet.svelte';
  import { searchStream, type Hit } from './lib/search';
  import { searchSources } from './lib/searchSources';
  import { addToWatchlist, blankTitle, markWatched, react, removeFromLibrary, unwatch } from './lib/actions';
  import { browserClock } from './lib/clock';
  import { sendToTV } from './lib/inbox';
  import {
    applyLog,
    continueWatching,
    emptyLibrary,
    titleKey,
    untitled,
    watchlist,
    withDisplay,
    type ContinueEntry,
    type Shape,
    type Title,
  } from './lib/library';
  import type { Link } from './lib/links.svelte';
  import { LibraryLog } from './lib/log';
  import { isHidden, readApiKey, readPrefs } from './lib/prefs';
  import { fetchDetails } from './lib/tmdb';
  import type { Stamp, TitleRow } from './lib/wire';

  let { link }: { link: Link } = $props();

  /** TMDB lookups at once while naming the library: quick for a big watchlist, and polite to TMDB. */
  const LOOKUPS = 6;

  /** The TMDB key the library shares (`set:keys`). */
  let tmdbKey = $state('');
  const clock = browserClock();
  /** The record log — reading it and writing to it. Undefined while it opens; null when it couldn't. */
  let log = $state<LibraryLog | null | undefined>(undefined);
  /** TMDB display for titles the log names without it, and for titles acted on here. */
  let displays = $state<Title[]>([]);
  /** Season layouts of the series in the library, from TMDB. */
  let shapes = $state(new Map<string, Shape>());
  /** Bumped after a write: the log isn't reactive, so the rows re-derive from it on this. */
  let version = $state(0);
  let selected = $state<Title | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);

  $effect(() => {
    void LibraryLog.open(link.libraryKey).then((opened) => {
      log = opened;
      if (!opened) return;
      clock.see(opened.newestStamp());
      tmdbKey = readApiKey(opened.settings('keys'), 'tmdb') ?? '';
      if (tmdbKey) void name(opened, tmdbKey);
    });
  });

  /** Every title the rows show, named from TMDB a few at a time, painted as each arrives. */
  async function name(opened: LibraryLog, key: string) {
    const queue = untitled(applyLog(emptyLibrary(), opened.rows()));
    const lookup = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const found = await fetchDetails(ref, key);
        if (!found) continue;
        displays = [...displays, found.title];
        if (found.shape) shapes = new Map(shapes).set(titleKey(ref), found.shape);
      }
    };
    await Promise.all(Array.from({ length: LOOKUPS }, lookup));
  }

  const library = $derived.by(() => {
    void version;
    if (!log) return null;
    return { ...withDisplay(applyLog(emptyLibrary(), log.rows()), displays), shapes };
  });

  const selectedRow = $derived.by(() => {
    void version;
    return selected ? log?.title(selected) : undefined;
  });

  /** Apply an action to the title's row as last read (or a blank one), stamped now, and write it. */
  async function act(title: Title, change: (row: TitleRow, at: Stamp) => TitleRow) {
    if (!log) return;
    if (!displays.some((d) => d.type === title.type && d.id === title.id)) displays = [...displays, title];
    busy = true;
    failure = null;
    const saved = await log.write(change(log.title(title) ?? blankTitle(title, Date.now()), clock.issue()));
    busy = false;
    if (!saved) failure = 'Couldn’t save that. Check that this device is on your network.';
    version++;
  }

  /** Start the title on the linked TV, as the TV's own Play would — it picks the source. */
  async function play(title: Title) {
    busy = true;
    failure = null;
    notice = null;
    const sent = await sendToTV(link, { type: 'play', tmdbId: title.id, mediaType: title.type, title: title.title });
    busy = false;
    if (sent) notice = `Sent to ${link.name ?? 'your TV'}. It starts when the TV is on and Den is open.`;
    else failure = 'Couldn’t reach your TV. Check that this device is on your network.';
  }

  const select = $derived(log ? (title: Title) => (selected = title) : undefined);
  // Search, as the TV's Search tab runs it: a pause after typing, then results that improve as sources answer;
  // a newer query supersedes an older one mid-flight.
  const sources = $derived(tmdbKey ? searchSources(tmdbKey) : null);
  /** The TV's hide rules, from the log's `set:prefs`. */
  const prefs = $derived.by(() => {
    void version;
    return readPrefs(log?.settings('prefs'));
  });
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
        // The TV's search filter: its hide rules, but not the year floor or Hide Watched — a title typed by name
        // must be findable.
        hits = batch.filter((h) => h.kind === 'person' || !isHidden(h.title, prefs, { ignoringYearFloor: true }));
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

{#if log === undefined}
  <p class="note">Loading your library…</p>
{:else if log === null || !library}
  <p class="note">
    Couldn’t open your library. Check that this device is on your network. If your TV reset its library key, unlink in
    <a href="#settings">Settings</a> and pair again.
  </p>
{:else}
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
  {:else}
    <p class="note">Search needs your TMDB key: your TV shares it, or add it in <a href="#settings">Settings</a>.</p>
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
  <p class="note small">Up to date with your TV.</p>
{/if}

{#if selected}
  {@const title = selected}
  <TitleSheet
    {title}
    row={selectedRow}
    {busy}
    {failure}
    {notice}
    onclose={() => {
      selected = null;
      failure = null;
      notice = null;
    }}
    onplay={() => play(title)}
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
