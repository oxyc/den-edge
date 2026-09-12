<script lang="ts">
  import Loading from './components/Loading.svelte';
  import { untrack } from 'svelte';
  import Billboard from './components/Billboard.svelte';
  import Browse from './components/Browse.svelte';
  import Detail from './components/Detail.svelte';
  import Person from './components/Person.svelte';
  import PosterCard from './components/PosterCard.svelte';
  import PosterRow from './components/PosterRow.svelte';
  import Player from './components/Player.svelte';
  import Search from './components/Search.svelte';
  import {
    addToWatchlist,
    blankEpisode,
    blankTitle,
    markEpisode,
    markWatched,
    react,
    removeFromLibrary,
    unwatch,
    updateEpisodeProgress,
    updateProgress,
    WATCHED,
  } from './lib/actions';
  import { pickBillboard, tasteOf, worth, type Candidate } from './lib/billboard';
  import { browseRows, homeRows, personalRows, tmdbPages } from './lib/catalog';
  import { browserClock } from './lib/clock';
  import { sendToTV } from './lib/inbox';
  import {
    applyLog,
    continueWatching,
    emptyLibrary,
    episodeAfter,
    isAired,
    titleKey,
    untitled,
    watchlist,
    withDisplay,
    type ContinueEntry,
    type Title,
  } from './lib/library';
  import { links, type Link } from './lib/links.svelte';
  import type { LibraryLog } from './lib/log';
  import type { LibrarySession } from './lib/librarySession.svelte';
  import { navigate } from './lib/navigation';
  import { nameLibraryTitles } from './lib/libraryNaming';
  import { recordTrackerEvent } from './lib/trackerEvents';
  import { ensureSyncPolicy } from './lib/syncLoader';
  import { availability } from './lib/availability.svelte';
  import { isHidden, readApiKey, readPlugins, readPrefs, readDetailPrefs } from './lib/prefs';
  import { titleHref, type Route } from './lib/route';
  import { discoverServices } from './lib/discoverServices';
  import { fetchRoutes, type Routes } from './lib/routes';
  import { arrivals, installsOf, trendingEverywhere, type Addon } from './lib/scout';
  import { fetchDetails, fetchTitle } from './lib/tmdb';
  import type { EpisodeRow, Row, SettingsRow, Stamp, TitleRow } from './lib/wire';

  let { link, route, active, session, query = '' }: { link: Link; route: Route; active: boolean; session: LibrarySession; query?: string } = $props();

  /** TMDB lookups at once while naming the library: quick for a big watchlist, and polite to TMDB. */
  const LOOKUPS = 6;
  const SAVE_FAILED = 'Couldn’t save that. Check that this device is on your network.';

  /** The TMDB key the library shares (`set:keys`). */
  let tmdbKey = $state('');
  const clock = browserClock();
  /** The record log — reading it and writing to it. Undefined while it opens; null when it couldn't. */
  const log = $derived(session.log);
  /** Bumped after a write: the log isn't reactive, so the rows re-derive from it on this. */
  const version = $derived(session.revision);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** The library's addons (`set:plugins`), and scout among them — what playing here needs. */
  let plugins = $state<string[]>([]);
  let scout = $state<Addon | null>(null);
  /** Where this page reaches atlas, search's indexes; null where it can't. */
  let atlas = $state<string | null>(null);
  /** Where this page reaches reel, the billboard's trailers; null where it can't. */
  let reel = $state<string | null>(null);
  /** den-edge's routes table: which installs are Den's own, and where den-remux answers (den-spec routes-v1). */
  let routes = $state<Routes>({});
  /** Where den-remux answers for this page (`findRemux`), so a title can play here; null where no route reaches it. */
  let remux = $state<string | null>(null);

  type Target = { title: Title; season?: number; episode?: number; filename?: string };
  /** What's playing in this browser. */
  let playing = $state<Target | null>(null);

  $effect(() => {
    const opened = log;
    if (opened) clock.see(opened.newestStamp());
  });

  $effect(() => {
    void session.settingsRevision;
    const opened = log;
    if (!opened) return;
    let disposed = false;
    let stopDiscovery: (() => void) | undefined;
    // Only the shared settings revision and opened log trigger reconfiguration.
    // Service state below is an output, not a dependency of this effect.
    untrack(() => {
      tmdbKey = readApiKey(opened.settings('keys'), 'tmdb') ?? '';
      if (tmdbKey) void name(opened, tmdbKey);
      plugins = readPlugins(opened.settings('plugins'));
      const [key, installed] = [tmdbKey, plugins];
      void (async () => {
        const foundRoutes = await fetchRoutes();
        if (disposed) return;
        routes = foundRoutes;
        stopDiscovery = discoverServices(installed, foundRoutes, {
          scout: (found) => { scout = found; availability.connect(found, key); },
          atlas: (found) => { atlas = found?.base ?? null; },
          reel: (found) => { reel = found?.base ?? null; },
          remux: (found) => { remux = found; },
        });
      })();
    });
    return () => { disposed = true; stopDiscovery?.(); };
  });

  /** Naming belongs to the shared session, including lookups still in flight on another page. */
  function name(opened: LibraryLog, key: string) {
    return nameLibraryTitles(session, untitled(applyLog(emptyLibrary(), opened.rows())), key);
  }

  const library = $derived.by(() => {
    void version;
    if (!log) return null;
    return { ...withDisplay(applyLog(emptyLibrary(), log.rows()), session.displays), shapes: session.shapes };
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

  // Transient messages and playback belong to the active page.
  $effect(() => {
    failure = null;
    notice = null;
    if (!active) playing = null;
  });

  function remember(title: Title) {
    if (!session.displays.some((d) => d.type === title.type && d.id === title.id)) session.displays = [...session.displays, title];
  }

  /** Write one row and re-derive what shows it. */
  async function save(row: Row, journal = false) {
    if (!log) return;
    busy = true;
    failure = null;
    try {
      const saved = journal && row.kind === 'set' ? await log.writeAction(row) : await log.write(row);
      if (log.moved) return links.forgetMoved(link);
      if (!saved) failure = SAVE_FAILED;
      else if (log.pendingActions > 0) notice = 'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.';
      session.changed();
      return saved !== null;
    } catch {
      failure = SAVE_FAILED;
      return false;
    } finally { busy = false; }
  }

  /** Apply an action to the title's row as last read (or a blank one), stamped now, and write it. */
  async function act(title: Title, change: (row: TitleRow, at: Stamp) => TitleRow) {
    if (!log) return;
    try {
      await ensureSyncPolicy();
      remember(title);
      const before = log.title(title) ?? blankTitle(title, Date.now());
      clock.see(log.newestStamp());
      const at = clock.issue();
      const event = recordTrackerEvent(before, change(before, at), at);
      return event ? await save(event, true) : true;
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  async function markEpisodeSeen(title: Title, season: number, episode: number, seen: boolean) {
    if (!log) return;
    try {
      await ensureSyncPolicy();
      remember(title);
      const row = log.episode(title, season, episode) ?? blankEpisode(title, season, episode);
      clock.see(log.newestStamp());
      const at = clock.issue();
      const event = recordTrackerEvent(row, markEpisode(row, seen, at), at);
      return event ? await save(event, true) : true;
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  /** Same regular-season/last-aired expansion as DenKit.SeriesProgress.airedEpisodes. */
  async function setSeen(title: Title, seen: boolean) {
    if (!log) return;
    try {
      await ensureSyncPolicy();
      if (title.type === 'tv') {
        const shape = session.shapes.get(titleKey(title)) ?? (await fetchDetails(title, tmdbKey))?.shape;
        if (!shape) { failure = 'Couldn’t load the episodes. Nothing was marked Seen.'; return; }
        const journals: SettingsRow[] = [];
        clock.see(log.newestStamp());
        for (const [season, count] of [...shape.counts].sort((a, b) => a[0] - b[0])) {
          if (season <= 0) continue;
          for (let episode = 1; episode <= count; episode++) {
            if (!isAired({ season, episode }, shape.lastAired)) continue;
            const before = log.episode(title, season, episode) ?? blankEpisode(title, season, episode);
            const at = clock.issue();
            const event = recordTrackerEvent(before, markEpisode(before, seen, at), at);
            if (event) journals.push(event);
          }
        }
        const before = log.title(title) ?? blankTitle(title, Date.now());
        const at = clock.issue();
        const event = recordTrackerEvent(before, (seen ? markWatched : unwatch)(before, at), at);
        if (event) journals.push(event);
        busy = true;
        failure = null;
        try {
          if (!await log.writeActions(journals)) failure = SAVE_FAILED;
          else if (log.pendingActions > 0) notice = 'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.';
          session.changed();
        } catch { failure = SAVE_FAILED; }
        finally { busy = false; }
        return;
      }
      await act(title, seen ? markWatched : unwatch);
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  /** Start the title on the linked TV, as the TV's own Play would — it picks the source. */
  async function play(title: Title, season?: number, episode?: number) {
    busy = true;
    failure = null;
    notice = null;
    const sent = await sendToTV(link, { type: 'play', tmdbId: title.id, mediaType: title.type, title: title.title, season, episode });
    busy = false;
    if (sent) notice = `Sent to ${link.name ?? 'your TV'}. It starts when the TV is on and Den is open.`;
    else failure = 'Couldn’t reach your TV. Check that this device is on your network.';
  }

  /**
   * Play in this browser, through den-remux: needs scout, for the release, and TMDB, for its IMDb id. A series with
   * no episode named picks up where Continue Watching would, or starts at the beginning.
   */
  const playHere = $derived(
    scout && tmdbKey && remux !== null
      ? (title: Title, season?: number, episode?: number, filename?: string) => {
          if (title.type === 'tv' && (season === undefined || episode === undefined)) {
            const up = library && continueWatching(library).find((e) => titleKey(e.title) === titleKey(title))?.episode;
            playing = { title, ...(up ?? { season: 1, episode: 1 }) };
          } else {
            playing = { title, season, episode, filename };
          }
        }
      : undefined,
  );

  /** The aired episode after the one playing, from the series' season layout; none after a movie or the last. */
  let following = $state<Target | null>(null);
  $effect(() => {
    const target = playing;
    following = null;
    if (!target || target.season === undefined || target.episode === undefined) return;
    const at = { season: target.season, episode: target.episode };
    void (async () => {
      const shape = session.shapes.get(titleKey(target.title)) ?? (await fetchDetails(target.title, tmdbKey))?.shape;
      const next = shape && episodeAfter(at, shape);
      if (playing === target && next && isAired(next, shape.lastAired)) following = { title: target.title, ...next };
    })();
  });

  function progressOf(target: Target) {
    const { title, season, episode } = target;
    return season !== undefined && episode !== undefined ? log?.episode(title, season, episode)?.progress : log?.title(title)?.resume;
  }

  /** Where the library says the target was left: nowhere once it was seen, so it plays from the start. */
  function resumePoint(target: Target): { fraction: number; seconds?: number } {
    const progress = progressOf(target);
    return progress && progress.value < WATCHED ? { fraction: progress.value, seconds: progress.seconds } : { fraction: 0 };
  }

  /** Where playback got to, written as the TV's player writes it. */
  async function progressed(target: Target, fraction: number, seconds: number) {
    if (!log) return;
    try {
      await ensureSyncPolicy();
      const { title, season, episode } = target;
      remember(title);
      if (season !== undefined && episode !== undefined) {
        const row = log.episode(title, season, episode) ?? blankEpisode(title, season, episode);
        await save(updateEpisodeProgress(row, fraction, seconds, clock.issue()));
      } else {
        await save(updateProgress(log.title(title) ?? blankTitle(title, Date.now()), fraction, seconds, clock.issue()));
      }
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  const open = (title: Title) => {
    navigate(titleHref(title));
  };
  const select = $derived(log ? open : undefined);
  /** The TV's hide rules, from the log's `set:prefs`. */
  const prefs = $derived.by(() => {
    void version;
    return readPrefs(log?.settings('prefs'));
  });
  const detailPrefs = $derived.by(() => { void session.settingsRevision; return readDetailPrefs(log?.settings('prefs')); });
  const warningKey = $derived.by(() => { void session.settingsRevision; return readApiKey(log?.settings('keys'), 'doesthedogdie') ?? ''; });
  const omdbKey = $derived.by(() => { void session.settingsRevision; return readApiKey(log?.settings('keys'), 'omdb') ?? ''; });
  const shown = (title: Title) => !isHidden(title, prefs);
  /** What the TV's discovery rows hide: its rules, and what you've seen when Hide Watched is on. */
  const watched = $derived(
    new Set(library?.records.filter((r) => !r.deleted && r.status === 'watched').map((r) => titleKey(r.title)) ?? []),
  );
  const browseShown = (title: Title) => shown(title) && !(prefs.hideWatched && watched.has(titleKey(title)));
  /** The billboard's own rule: everything the rows hide, except the missing poster it doesn't draw. */
  const featuredShown = (title: Title) =>
    !isHidden(title, prefs, { requirePoster: false }) && !(prefs.hideWatched && watched.has(titleKey(title)));
  /**
   * What this library says it likes, for the billboard's taste term. Watched and part-watched titles are a
   * verdict and count full; a watchlisted one is an intention and counts for less; a reaction is the one thing
   * said outright, so it counts for more than either, and a dislike counts against. Titles TMDB hasn't named yet
   * carry no genres, so they simply don't vote.
   */
  const taste = $derived.by(() => {
    void version;
    // Reactions live on the log's rows; the records carry only status. A title is read by both.
    const reactions = new Map(
      (log?.rows() ?? [])
        .filter((r): r is TitleRow => r.kind === 'rec' && !r.deleted.value)
        .map((r) => [titleKey(r.title), r.reaction.value]),
    );
    const weightOf = (status: string, reaction: string | null | undefined) => {
      // Turning something down is the whole verdict; that they sat through it doesn't soften it.
      if (reaction === 'dislike') return -1.5;
      const seen = status === 'watched' || status === 'inProgress' ? 1 : status === 'watchlist' ? 0.6 : 0;
      return seen + (reaction === 'love' ? 1 : reaction === 'like' ? 0.5 : 0);
    };
    return tasteOf(
      (library?.records ?? []).flatMap((r) => {
        if (r.deleted || r.title.title === '') return [];
        const weight = weightOf(r.status, reactions.get(titleKey(r.title)));
        return weight === 0 ? [] : [{ title: r.title, weight }];
      }),
    );
  });
  /** The browse screens' rows, headers now and posters as each nears the screen. */
  const pages = $derived(tmdbKey ? tmdbPages(tmdbKey) : null);
  /** The seeds of Home's personal rows: your two latest watched or liked titles, and two latest watchlisted, named. */
  const seeds = $derived.by(() => {
    void version;
    const titleRows = (log?.rows() ?? []).filter((r): r is TitleRow => r.kind === 'rec' && !r.deleted.value);
    const named = new Map((library?.records ?? []).filter((r) => r.title.title).map((r) => [titleKey(r.title), r.title]));
    const recency = (r: TitleRow) => Math.max(r.watchedAt ?? 0, r.reaction.at[0], r.addedAt);
    const latest = (keep: (r: TitleRow) => boolean) =>
      titleRows
        .filter(keep)
        .sort((a, b) => recency(b) - recency(a))
        .flatMap((r) => named.get(titleKey(r.title)) ?? [])
        .slice(0, 2);
    return {
      watched: latest((r) => r.status.value === 'watched' || r.reaction.value === 'like' || r.reaction.value === 'love'),
      watchlisted: latest((r) => r.status.value === 'watchlist'),
      owned: new Set(titleRows.map((r) => titleKey(r.title))),
    };
  });
  const rows = $derived.by(() => {
    if (!pages) return [];
    const minYear = prefs.minReleaseYear;
    if (route.page === 'movies' || route.page === 'series') {
      return browseRows(route.page === 'movies' ? 'movie' : 'tv', pages, { minYear, hiddenGenres: prefs.excludedGenres });
    }
    return [...personalRows(pages, seeds), ...homeRows(pages, { minYear })];
  });
  /** The screen's own facet: Movies shows your movies, Series your series, Home both. */
  const facet = $derived(route.page === 'movies' ? 'movie' : route.page === 'series' ? 'tv' : null);
  /**
   * What the billboard cycles. Not a row: a pool of its own, ranked by `pickBillboard` — what is being watched
   * now, what is new or still to come, and what has just landed on this household's own services, weighted
   * towards the library's taste and away from anything it already holds.
   */
  let featured = $state<Title[]>([]);
  /** Which build of the billboard is the current one: a slower earlier one must not overwrite a later answer. */
  let billboardRun = 0;
  $effect(() => {
    // What the billboard is rebuilt FOR: which page this is, where atlas answers, and whether TMDB can be
    // asked at all. Everything else it reads — the rows, the library's shape, the hide rules, the taste — is
    // read without being watched. Those tick over continuously while the library is named, and watching them
    // had the whole pool rebuilt on every tick: hundreds of repeat requests to atlas for one page load.
    if (route.page === 'title' || route.page === 'person' || route.page === 'search') return;
    const here = atlas;
    if (!tmdbKey) return;
    untrack(() => buildBillboard(here));
  });

  function buildBillboard(here: string | null) {
    const table = rows;
    const type = facet;
    // Not the rows' identity: that array is rebuilt every time a title is named, so comparing it when the
    // fetches came back meant the answer was always judged stale and thrown away, and the billboard stayed
    // empty. A build is stale only when a later build has started.
    const run = ++billboardRun;
    // A late discovery service can improve the pool. Keep the current slides while it loads.
    if (!table.length) return;
    const row = (id: string) => table.find((r) => r.id === id)?.load(1).catch(() => []) ?? Promise.resolve([]);
    // The billboard gets a pool of its own rather than whatever row happens to lead the page. A "Because you
    // watched" row is the nearest neighbours of something already seen, which at the top of the page reads as
    // a shelf of old, half-familiar titles — so what goes in is what is being watched now (atlas's "Trending
    // Everywhere", the catalog the TV's browse billboards lead with) and what is new or not yet out.
    // TMDB's trending as well as atlas's: atlas names a title by id and year, so its titles arrive with no
    // genres and no rating and can only score on their ranking, while TMDB's arrive complete. The two lists
    // overlap heavily and the picker merges what they share, which is how a trending title ends up scored on
    // everything rather than on its place in one list.
    const feed = pages;
    const trendingTv = feed ? feed('/trending/tv/week', 'tv', {}, 1).catch(() => []) : Promise.resolve([]);
    void Promise.all([
      here ? trendingEverywhere(here, fetch, type ?? undefined) : Promise.resolve([] as Title[]),
      row('trending'),
      trendingTv,
      row('new-releases'),
      row('upcoming'),
      row('popular'),
      // What just landed on the services this household actually has — new to watch, whatever year it is from.
      here ? arrivals(here, prefs.services) : Promise.resolve([] as Title[][]),
    ])
      .then(async ([everywhere, hotMovies, hotSeries, fresh, soon, popular, landed]) => {
        const ranked = (list: Title[]) => list.map((title, rank) => ({ title, rank, of: list.length }));
        const pool: Candidate[] = [
          ...landed.flatMap((list) => list.map((title, rank) => ({ title, arrival: { rank, of: list.length } }))),
          ...ranked(everywhere),
          ...ranked(hotMovies),
          ...ranked(hotSeries),
          ...[...fresh, ...soon, ...popular].map((title) => ({ title })),
        ];
        const named = await nameCandidates(pool);
        // Only titles we actually know something about. atlas hands over hundreds named by id alone, and an
        // unjudged title cannot be matched against this library's taste or dropped for missing it — so it
        // competes on attention and freshness only, and wins slides against titles that were judged. Since the
        // ones asked of TMDB are the best of the pool to begin with, dropping the rest costs nothing. The guard
        // is for the day TMDB can't be reached at all: better an unjudged billboard than an empty one.
        const judged = named.filter((c) => c.title.genreIds?.length);
        const pickable = judged.length >= 20 ? judged : named;
        // Never a title this library already holds: the billboard is for what hasn't been found yet.
        const picked = pickBillboard(pickable, {
          taste,
          keep: (t) => featuredShown(t) && !seeds.owned.has(titleKey(t)),
        });
        if (run === billboardRun && (picked.length || !featured.length)) featured = picked;
      })
      .catch(() => undefined);
  }

  /**
   * Ask TMDB about the candidates that arrived knowing nothing about themselves.
   *
   * atlas names a title by id, name and year and nothing else, so everything from a "new on <service>" catalog
   * reached the picker with no genres to match a taste against, no rating and no popularity — which left the
   * billboard deciding on "what is new on your services" alone, and this library's own leanings unable to touch
   * it. The strongest few by their place in those lists are named properly first. Bounded, and `tmdbFetch`
   * caches, so a hundred arrivals don't become a hundred requests.
   */
  async function nameCandidates(pool: Candidate[], most = 60): Promise<Candidate[]> {
    const key = tmdbKey;
    // By what a title is worth before taste — not by which arrivals list it came from. Nine candidates in ten
    // reach here knowing only their own id, and an unnamed one has no genres, so taste cannot weigh it at all:
    // it rides on attention and lands high whatever the household likes. These are the ones that could
    // plausibly make the billboard, so these are the ones worth a request.
    const busiest = pool.reduce((most_, { title }) => Math.max(most_, title.popularity ?? 0), 0);
    const now = new Date();
    const bare = pool
      .filter((c) => !c.title.genreIds)
      .sort((a, b) => worth(b, now, busiest) - worth(a, now, busiest))
      .slice(0, most);
    if (!key || bare.length === 0) return pool;
    const queue = [...bare];
    const found = new Map<string, Title>();
    const lookup = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const title = await fetchTitle({ type: next.title.type, id: next.title.id }, key).catch(() => null);
        if (title) found.set(titleKey(title), title);
      }
    };
    await Promise.all(Array.from({ length: LOOKUPS }, lookup));
    return pool.map((c) => {
      const better = found.get(titleKey(c.title));
      return better ? { ...c, title: { ...c.title, ...better } } : c;
    });
  }

  function caption(entry: ContinueEntry): string | undefined {
    if (entry.episode) return `S${entry.episode.season} · E${entry.episode.episode}`;
    return entry.title.year ? String(entry.title.year) : undefined;
  }
</script>

{#if log === undefined}
  <Loading label="Loading your library" page />
{:else if log === null || !library}
  <p class="note">
    Couldn’t open your library. Check that this device is on your network. If your TV reset its library key, unlink in
    <a href="#settings">Settings</a> and pair again.
  </p>
{:else if route.page !== 'library' && !tmdbKey}
  <p class="note">This page needs your TMDB key: your TV shares it, or add it in <a href="#settings">Settings</a>.</p>
{:else if page}
  <Detail
    {reel}
    {routes}
    {active}
    ref={page}
    {tmdbKey}
    {omdbKey}
    {warningKey}
    warningCategories={detailPrefs.warningCategories}
    region={detailPrefs.region}
    ratingSources={detailPrefs.ratingSources}
    autoplay={detailPrefs.autoplay}
    {scout}
    row={pageRow}
    episodes={pageEpisodes}
    {busy}
    {failure}
    {notice}
    onwatchlist={(title, on) => act(title, on ? addToWatchlist : removeFromLibrary)}
    onseen={setSeen}
    onreact={(title, reaction) => act(title, (row, at) => react(row, reaction, at))}
    onplay={play}
    onplayhere={playHere}
    onepisode={markEpisodeSeen}
    onselect={open}
    {shown}
  />
{:else if route.page === 'person'}
  <Person id={route.id} {tmdbKey} {active} onselect={open} />
{:else if route.page === 'search'}
  <Search {query} {tmdbKey} {atlas} {prefs} onselect={select} />
{:else}
  {@const resume = continueWatching(library).filter((e) => !facet || e.title.type === facet)}
  {@const saved = watchlist(library).filter((t) => !facet || t.type === facet)}
  <!-- The billboard reaches the top of the window and runs behind the navigation bar. -->
  <!-- Kept in the page while the library is still opening, so its space is held from the first paint and the
       rows below don't jump down when the titles arrive. -->
  {#if tmdbKey || log === undefined}
    <Billboard
      {active}
      titles={featured.filter(featuredShown)}
      {tmdbKey}
      {reel}
      {routes}
      onplay={playHere && ((title) => playHere(title))}
    />
  {/if}
  {#if resume.length}
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
  {#if saved.length}
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
  <Browse {rows} shown={browseShown} onselect={open} />
{/if}

{#if playing && scout && remux !== null}
  {@const target = playing}
  {@const after = following}
  {#key `${titleKey(target.title)}:${target.season}:${target.episode}`}
    <Player
      title={target.title}
      season={target.season}
      episode={target.episode}
      filename={target.filename}
      {tmdbKey}
      {scout}
      {remux}
      subtitles={installsOf(plugins, routes, 'subs')}
      resume={resumePoint(target)}
      next={after ? `S${after.season} · E${after.episode}` : undefined}
      onprogress={(fraction, seconds) => void progressed(target, fraction, seconds)}
      onnext={after ? () => (playing = after) : undefined}
      onclose={() => (playing = null)}
    />
  {/key}
{/if}

<style>
  .note {
    color: var(--muted);
  }
</style>
