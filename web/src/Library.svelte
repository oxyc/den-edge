<script lang="ts">
  import Browse from './components/Browse.svelte';
  import Detail from './components/Detail.svelte';
  import Person from './components/Person.svelte';
  import PosterCard from './components/PosterCard.svelte';
  import PosterRow from './components/PosterRow.svelte';
  import SearchResults from './components/SearchResults.svelte';
  import { searchStream, type Hit } from './lib/search';
  import { searchSources } from './lib/searchSources';
  import {
    addToWatchlist,
    blankEpisode,
    blankTitle,
    markEpisode,
    markWatched,
    react,
    removeFromLibrary,
    unwatch,
  } from './lib/actions';
  import { browseRows, homeRows, tmdbPages } from './lib/catalog';
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
  import { titleHref, type Route } from './lib/route';
  import { fetchDetails } from './lib/tmdb';
  import type { EpisodeRow, Row, Stamp, TitleRow } from './lib/wire';

  let { link, route }: { link: Link; route: Route } = $props();

  /** TMDB lookups at once while naming the library: quick for a big watchlist, and polite to TMDB. */
  const LOOKUPS = 6;
  const SAVE_FAILED = 'Couldn’t save that. Check that this device is on your network.';

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

  /** The title whose page is open, if one is. */
  const page = $derived(route.page === 'title' ? { type: route.type, id: route.id } : null);
  const pageRow = $derived.by(() => {
    void version;
    return page ? log?.title(page) : undefined;
  });
  const pageEpisodes = $derived.by(() => {
    void version;
    const rows = new Map<string, EpisodeRow>();
    if (!page || !log) return rows;
    for (const row of log.rows()) {
      if (row.kind === 'ep' && row.title.type === page.type && row.title.id === page.id) {
        rows.set(`${row.season}:${row.episode}`, row);
      }
    }
    return rows;
  });

  // A new page starts clean, and at its top.
  $effect(() => {
    failure = null;
    notice = null;
    if (route.page !== 'library') scrollTo(0, 0);
  });

  function remember(title: Title) {
    if (!displays.some((d) => d.type === title.type && d.id === title.id)) displays = [...displays, title];
  }

  /** Write one row and re-derive what shows it. */
  async function save(row: Row) {
    if (!log) return;
    busy = true;
    failure = null;
    const saved = await log.write(row);
    busy = false;
    if (!saved) failure = SAVE_FAILED;
    version++;
  }

  /** Apply an action to the title's row as last read (or a blank one), stamped now, and write it. */
  async function act(title: Title, change: (row: TitleRow, at: Stamp) => TitleRow) {
    if (!log) return;
    remember(title);
    await save(change(log.title(title) ?? blankTitle(title, Date.now()), clock.issue()));
  }

  async function markEpisodeSeen(title: Title, season: number, episode: number, seen: boolean) {
    if (!log) return;
    remember(title);
    const row = log.episode(title, season, episode) ?? blankEpisode(title, season, episode);
    await save(markEpisode(row, seen, clock.issue()));
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

  const open = (title: Title) => {
    location.hash = titleHref(title);
  };
  const select = $derived(log ? open : undefined);
  // Search, as the TV's Search tab runs it: a pause after typing, then results that improve as sources answer;
  // a newer query supersedes an older one mid-flight.
  const sources = $derived(tmdbKey ? searchSources(tmdbKey) : null);
  /** The TV's hide rules, from the log's `set:prefs`. */
  const prefs = $derived.by(() => {
    void version;
    return readPrefs(log?.settings('prefs'));
  });
  const shown = (title: Title) => !isHidden(title, prefs);
  /** What the TV's discovery rows hide: its rules, and what you've seen when Hide Watched is on. */
  const watched = $derived(
    new Set(library?.records.filter((r) => !r.deleted && r.status === 'watched').map((r) => titleKey(r.title)) ?? []),
  );
  const browseShown = (title: Title) => shown(title) && !(prefs.hideWatched && watched.has(titleKey(title)));
  /** The browse screens' rows, headers now and posters as each nears the screen. */
  const pages = $derived(tmdbKey ? tmdbPages(tmdbKey) : null);
  const rows = $derived.by(() => {
    if (!pages) return [];
    const minYear = prefs.minReleaseYear;
    if (route.page === 'movies' || route.page === 'series') {
      return browseRows(route.page === 'movies' ? 'movie' : 'tv', pages, { minYear, hiddenGenres: prefs.excludedGenres });
    }
    return homeRows(pages, { minYear });
  });
  /** The screen's own facet: Movies shows your movies, Series your series, Home both. */
  const facet = $derived(route.page === 'movies' ? 'movie' : route.page === 'series' ? 'tv' : null);
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
{:else if route.page !== 'library' && !tmdbKey}
  <p class="note">This page needs your TMDB key: your TV shares it, or add it in <a href="#settings">Settings</a>.</p>
{:else if page}
  <Detail
    ref={page}
    {tmdbKey}
    row={pageRow}
    episodes={pageEpisodes}
    {busy}
    {failure}
    {notice}
    onwatchlist={(title, on) => act(title, on ? addToWatchlist : removeFromLibrary)}
    onseen={(title, on) => act(title, on ? markWatched : unwatch)}
    onreact={(title, reaction) => act(title, (row, at) => react(row, reaction, at))}
    onplay={play}
    onepisode={markEpisodeSeen}
    onselect={open}
    {shown}
  />
{:else if route.page === 'person'}
  <Person id={route.id} {tmdbKey} onselect={open} {shown} />
{:else}
  {@const resume = continueWatching(library).filter((e) => !facet || e.title.type === facet)}
  {@const saved = watchlist(library).filter((t) => !facet || t.type === facet)}
  {#if sources && !facet}
    <input
      class="search glass"
      type="search"
      placeholder="Search movies, series and people"
      aria-label="Search movies, series and people"
      autocomplete="off"
      bind:value={query}
      oninput={queryChanged}
    />
  {:else if !sources}
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
  {#if !hits}
    <Browse {rows} shown={browseShown} onselect={open} />
  {/if}
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
</style>
