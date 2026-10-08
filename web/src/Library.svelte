<script lang="ts">
  import Loading from './components/Loading.svelte';
  import ScreenLoading from './components/ScreenLoading.svelte';
  import { untrack } from 'svelte';
  import Billboard from './components/Billboard.svelte';
  import Browse from './components/Browse.svelte';
  import DownloadPosterCard from './components/DownloadPosterCard.svelte';
  import PendingPosterRow from './components/PendingPosterRow.svelte';
  import PosterCard from './components/PosterCard.svelte';
  import { downloads, inFlight } from './lib/downloadQueue.svelte';
  import { headline } from './lib/downloadStatus';
  import WindowedPosterRow from './components/WindowedPosterRow.svelte';
  import { seenEpisodes, watchedHistory } from './lib/history';
  import {
    DetailScreen,
    DownloadsScreen,
    PeopleScreen,
    PersonScreen,
    PlayerScreen,
    preloadScreens,
    SearchScreen,
    ServiceScreen,
    WatchlistScreen,
  } from './lib/screens.svelte';
  import {
    addToWatchlist,
    blankEpisode,
    blankTitle,
    dismissFromContinueWatching,
    markEpisode,
    markWatched,
    react,
    removeFromLibrary,
    restoreToContinueWatching,
    unwatch,
    unwatchSeries,
    updateEpisodeProgress,
    updateProgress,
    WATCHED,
  } from './lib/actions';
  import { browseRows, homeRows, interleave, personalRows, tmdbPages } from './lib/catalog';
  import { browserClock } from './lib/clock';
  import { sendToTV } from './lib/inbox';
  import { playGuard } from './lib/playGuard';
  import { digestHomeLibraryView, homeLibraryViewFromCurrent } from './lib/homeLibraryView';
  import { devHomeLibraryView } from './lib/libraryWorkerClient';
  import { PlayOnTvTracker } from './lib/playOnTv.svelte';
  import {
    episodeAfter,
    isAired,
    standings,
    hasUntitledTitle,
    titleKey,
    untitled,
    watchlist,
    watchlistSlides,
    type ContinueEntry,
    type Title,
  } from './lib/library';
  import { links, type Link } from './lib/links.svelte';
  import { clock as timecode, livePosition } from './lib/livePosition';
  import { libraryStandings } from './lib/standing.svelte';
  import type { LibrarySession } from './lib/librarySession.svelte';
  import {
    nameActiveHomeShelfTitles,
    nameLibraryHistoryTitles,
    nameLibraryShelfTitles,
    promoteLibraryTitle,
    personalSeedRows,
    type BackgroundNaming,
    type ShelfNaming,
    type ShelfPlan,
  } from './lib/libraryNaming';
  import { recordTrackerEvent } from './lib/trackerEvents';
  import { ensureSyncPolicy } from './lib/syncLoader';
  import { isHidden, readApiKey, readPrefs, readDetailPrefs } from './lib/prefs';
  import { readSyncedPrefs } from './settings/values';
  import { fetchSources, nativeHls, trailerCandidates } from './lib/reel';
  import { navigate } from './lib/navigation';
  import { titleHref, watchlistHref, type Explore, type PeopleView, type Route } from './lib/route';
  import { warmOnIntent } from './lib/warmOnIntent';
  import { pressedCard } from './lib/detail';
  import {
    atlasCatalogs,
    GUEST_PICKS,
    mergeNewRow,
    primeServicePage,
    radarRows,
    resolvePicks,
    type AtlasCatalog,
  } from './lib/services';
  import { fetchServices, type Service } from './settings/services';
  import ServicesRow from './components/ServicesRow.svelte';
  import { setTitleActionsContext } from './lib/titleActions';
  import { setToastContext } from './lib/toast';
  import { guestGrants } from './lib/grants.svelte';
  import { sharedInstallOf } from './lib/grants';
  import { installsOf } from './lib/scout';
  import { fetchDetails, fetchTitle } from './lib/tmdb';
  import {
    billboardScope,
    displayableKept,
    enrichPersonalBackdrop,
    freshOn,
    memberPostOn,
    nameSlides,
    recommend,
    recommendBody,
    recommendForEveryone,
    replacePersonalBillboard,
    swapAfter,
    type KeptBillboard,
    type RecommendedTitle,
  } from './lib/recommend';
  import { atlasRows } from './lib/atlasRows';
  import type { EpisodeRow, Row, SettingsRow, Stamp, TitleRow } from './lib/wire';

  let {
    link,
    libraryIdentity,
    route,
    active,
    session,
    query = '',
    explore = {},
    people = {},
    watchedYear,
  }: {
    /** Null for a guest: someone browsing who has not paired, and so has no library behind them. */
    link: Link | null;
    /** The exact library key, including a browser-local library where `link` is null. */
    libraryIdentity?: string | null;
    route: Route;
    active: boolean;
    session: LibrarySession;
    query?: string;
    /** What Search's Explore state is browsing, from the address as `query` is. */
    explore?: Explore;
    /** What People is browsing, from the address as `explore` is. */
    people?: PeopleView;
    /** The year Watched shows, from the address as `people` is. */
    watchedYear?: string;
  } = $props();

  /** TMDB lookups at once while naming the library: quick for a big watchlist, and polite to TMDB. */
  const LOOKUPS = 6;
  /** Slides of everyone's billboard named for an empty library: atlas names them by id, each a TMDB lookup. */
  const EVERYONE_NAMED = 20;
  /** Let the hero's loaded image reach a paint before background provider synchronization starts. */
  const PROVIDERS_AFTER_HERO_MS = 1_000;
  /** Last exact Continue presence, sealed by `LibraryLog.keep`; it reserves layout only, never membership. */
  const KEPT_HOME_SHELVES = 'home.shelves.v1';
  const warnKeep = (error: unknown) => console.warn('den: Home could not be kept', error);
  const SAVE_FAILED = 'Couldn’t save that. Check that this device is on your network.';

  /** Keep the initial shelves together; naming must not insert rows above an already painted row. */
  let shelvesReady = $state(false);
  let shelfPlan = $state.raw<ShelfPlan | null>(null);
  /** The exact shelf membership is known. Until then a lower row must not paint ahead of Continue Watching. */
  let shelfPlanReady = $state(false);
  /** Continue's geometry is either reserved or proven absent, so every lower Home row has a stable place. */
  const shelfOrderReady = $derived(shelfPlanReady || shelfPlan?.continue === true);
  let shelfNaming = $state.raw<ShelfNaming | null>(null);
  let historyNaming = $state.raw<BackgroundNaming | null>(null);
  const clock = browserClock();
  /** The record log — reading it and writing to it. Undefined while it opens; null when it couldn't. */
  const log = $derived(session.log);
  /** Compact worker-owned state is usable only on Home; every other route asks the session to hydrate. */
  const stagedHome = $derived(route.page === 'library' ? session.activeHome : null);
  const stagedHomeHandle = $derived(stagedHome?.handle ?? null);
  /** Hydration installs `log` before compact Home retires; that ownership overlap must not restart naming. */
  const libraryNamingSource = $derived(
    stagedHomeHandle === null ? log : `staged:${stagedHomeHandle}`,
  );
  const libraryNamingSettingsRevision = $derived(
    stagedHomeHandle === null ? session.settingsRevision : 0,
  );
  /** Bumped after a write: the log isn't reactive, so the rows re-derive from it on this. */
  const version = $derived(session.revision);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /**
   * Where the library's services answer, found once for the session and shared by every page. The parent keys this
   * whole tree by its library, so the session is fixed for its life.
   */
  const discovered = untrack(() => session.services);
  const tmdbKey = $derived(discovered.tmdbKey);
  /** The library's addons (`set:plugins`), and scout among them — what playing here needs. */
  const plugins = $derived(discovered.plugins);
  const scout = $derived(discovered.scout);
  const atlas = $derived(discovered.atlas);
  const atlasReady = $derived(discovered.atlasReady);
  const reel = $derived(discovered.reel);
  const routes = $derived(discovered.routes);
  const remux = $derived(discovered.remux);
  const remuxAway = $derived(discovered.remuxAway);
  const remuxBlocked = $derived(discovered.remuxBlocked);

  type Target = { title: Title; season?: number; episode?: number; filename?: string };
  /** What's playing in this browser. */
  let playing = $state<Target | null>(null);

  /** Feedback after a "Play on TV" press (den-edge#235): drives `session.notify` on its own; fed live positions
   * below, as the library pull sees them. The parent keys this whole tree by `session`, so it is fixed for this
   * component's life, same as `discovered` above. */
  const playOnTv = untrack(() => new PlayOnTvTracker(session));
  $effect(() => () => playOnTv.stop());

  $effect(() => {
    const opened = log;
    if (opened) clock.see(opened.newestStamp());
  });

  const refOfKey = (key: string): Pick<Title, 'type' | 'id'> | undefined => {
    const match = /^(movie|tv):(\d+)$/.exec(key);
    const id = Number(match?.[2]);
    return match && Number.isSafeInteger(id) && id > 0
      ? { type: match[1] as Title['type'], id }
      : undefined;
  };
  let libraryNamingDeferredForTitle = false;
  let libraryNamingResume = $state(0);
  // The large naming effect stays attached to its library across ordinary navigation. Only a title transition that
  // deliberately skipped its staged -> hydrated rerun needs to restart it when Home becomes visible again.
  $effect(() => {
    if (route.page !== 'title' && libraryNamingDeferredForTitle) {
      libraryNamingDeferredForTitle = false;
      libraryNamingResume++;
    }
  });
  $effect(() => {
    void libraryNamingResume;
    void libraryNamingSettingsRevision;
    const source = libraryNamingSource;
    const opened = untrack(() => log);
    const staged = untrack(() => stagedHome);
    // `undefined` is a library still opening. `null` is a guest — no library, and still every reason to run
    // the discovery: atlas gives them rows and reel gives them trailers, both on this origin.
    if (source === undefined) return;
    // The shared grants are read here so a grant that arrives or ends asks again (`guestGrants.list` is state).
    void guestGrants.pluginUrls();
    let disposed = false;
    let background: BackgroundNaming | null = null;
    // Only the shared settings revision and opened log trigger reconfiguration.
    // Service state is an output, not a dependency of this effect.
    untrack(() => {
      if (staged) discovered.configureActive(staged.settings);
      else discovered.configure(opened ?? null);
      // A title page reads its own rows directly. Rebuilding every Home shelf while its hero mounts used to run
      // the whole Continue policy for an invisible retained route; returning Home starts a fresh naming run.
      if (route.page === 'title' && (session.detailBridgeContinueWatching?.() ?? null) !== null) {
        libraryNamingDeferredForTitle = true;
        return;
      }
      // Naming the library is still only the paired case: it reads the log itself.
      const key = discovered.tmdbKey;
      if (key && (opened || staged)) {
        // An initial run may be replaced before it becomes ready. Never let its plan paint for the replacement.
        shelvesReady = false;
        shelfPlan = null;
        shelfPlanReady = false;
        const projection = opened && !staged ? session.libraryProjection() : null;
        if (opened && !staged && !projection) return;
        const raw = projection?.library;
        const naming = staged
          ? nameActiveHomeShelfTitles(session, staged, key)
          : nameLibraryShelfTitles(session, raw!, projection!.rows, key);
        shelfNaming = naming;
        shelfPlan = naming.initialPlan;
        // A prior exact positive may reserve the portrait row while this visit validates TV layouts. It cannot
        // release lower shelves or supply cards, and the current exact plan always replaces it.
        if (opened && !naming.initialPlan.continue)
          void opened.kept<{ continue?: unknown }>(KEPT_HOME_SHELVES).then((saved) => {
            if (!disposed && !shelfPlanReady && saved?.continue === true)
              shelfPlan = { ...(shelfPlan ?? naming.initialPlan), continue: true };
          });
        let exactPlan: ShelfPlan | undefined;
        void naming.planned.then((plan) => {
          if (!disposed) {
            exactPlan = plan;
            shelfPlan = plan;
            shelfPlanReady = true;
          }
        });
        void naming.ready
          .then(() => {
            if (disposed) return;
            shelvesReady = true;
            if (exactPlan && opened)
              void opened.keep(KEPT_HOME_SHELVES, { continue: exactPlan.continue }).catch(warnKeep);
            if (!opened || !raw) return;
            const reserved = new Set(naming.refs.map(titleKey));
            // Watched history is not drawn on Home and cannot change the ranking already in flight. Keep its
            // potentially large TMDB tail dormant until the Watchlist screen can actually use the names.
            background = nameLibraryHistoryTitles(
              session,
              () => untitled(raw).filter((ref) => !reserved.has(titleKey(ref))),
              key,
              {
                owns: (ref) => !reserved.has(titleKey(ref)) && hasUntitledTitle(raw, ref),
              },
            );
            historyNaming = background;
            if (!active || route.page !== 'watchlist') background.pause();
          })
          .catch((error) => {
            if (disposed) return;
            console.warn('den: Library shelves could not be named', error);
            shelvesReady = true;
          });
      } else {
        shelfPlan = null;
        shelfPlanReady = true;
        shelvesReady = true;
      }
    });
    return () => {
      disposed = true;
      shelfNaming?.cancel();
      shelfNaming = null;
      background?.cancel();
      if (historyNaming === background) historyNaming = null;
    };
  });

  // A retained route names watched history only on the screen that draws it. Document visibility is watched by the
  // queue itself, because it can change without any Svelte state changing.
  $effect(() => {
    const background = historyNaming;
    if (!background) return;
    if (active && route.page === 'watchlist') background.resume();
    else background.pause();
  });

  // Compact state is deliberately a Home-only surface. A directly opened route asks for the ordinary log at once.
  $effect(() => {
    if (active && route.page !== 'library' && session.activeHome) void session.ensureLog(true);
  });

  // The full-library screen owns every saved/continued title. Fill its progressive Home tail in small idle
  // tranches; a retained Home keeps that tail dormant until a row is actually explored.
  $effect(() => {
    const naming = shelfNaming;
    if (active && route.page === 'watchlist' && naming) void naming.drain();
  });

  /** The log's rows and fold, only when the log changes: names arrive more often and are laid over it below. */
  const projection = $derived.by(() => {
    void version;
    return session.libraryProjection();
  });
  const applied = $derived(projection?.library ?? null);
  /**
   * Home's Worker answer remains exact across route hydration. Use it on a title page until a real row revision,
   * avoiding an otherwise invisible whole-library display/Continue pass during the detail hero's first paint.
   */
  const retainedDetailContinue = $derived(
    route.page === 'title' ? (session.detailBridgeContinueWatching?.() ?? null) : null,
  );
  const retainedDetailStandings = $derived(
    route.page === 'title' ? (session.detailBridgeStandings?.() ?? null) : null,
  );
  /** One pass shared by recommendation weighting, personal seeds and owned-title filtering. */
  const personalTitleRows = $derived.by(() => {
    const titleRows: TitleRow[] = [];
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Published only once as part of this derived snapshot.
    const reactions = new Map<string, TitleRow['reaction']['value']>();
    for (const row of projection?.rows ?? []) {
      if (row.kind !== 'rec' || row.deleted.value) continue;
      titleRows.push(row);
      reactions.set(titleKey(row.title), row.reaction.value);
    }
    return { titleRows, reactions, selected: personalSeedRows(titleRows) };
  });
  const library = $derived(applied && session.displayedLibrary(applied));
  /**
   * TMDB names arrive in small batches. They change the cards, but not den-core's answer about which episode
   * continues a series. Keep those policy decisions across display-only flushes and invalidate each series only
   * when its marks, shape, dismissal or watched state changes.
   */
  const continueEntries = $derived(
    stagedHome
      ? session.activeHomeContinueWatching()
      : retainedDetailContinue !== null
        ? retainedDetailContinue
        : applied && library
          ? session.continueWatching(applied, library)
          : [],
  );

  // Every poster marks what the library says of its title: seen, on the watchlist, or being watched.
  $effect(() =>
    libraryStandings.set(
      stagedHome
        ? new Map(stagedHome.view.standings)
        : (retainedDetailStandings ?? (applied ? standings(applied) : new Map())),
    ),
  );
  $effect(() => () => libraryStandings.set(new Map()));

  /**
   * The clock a Continue Watching card shows while its title plays on some device. It ticks each second only
   * while something is playing, and meanwhile the library is pulled faster, so a pause stops it soon.
   */
  let now = $state(Date.now());
  const playingAnywhere = $derived(
    continueEntries.some((entry) => livePosition(entry, now) !== undefined),
  );
  $effect(() => {
    session.live = playingAnywhere || playOnTv.active;
    if (!playingAnywhere) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // Fed to the "Play on TV" tracker on every pull, so it can notice a fresh position without a poll of its own.
  $effect(() => playOnTv.observe(continueEntries));
  // A fresh position arriving from a pull is live again without waiting for a tick to notice.
  $effect(() => {
    void applied;
    now = Date.now();
  });
  /** Home's Downloading row: only while something is in flight, as the TV's shelf (den-spec library-v4 §17). */
  const downloading = $derived(
    stagedHome
      ? stagedHome.view.downloads.filter((d) => inFlight(downloads.status(d).state))
      : log
        ? downloads.list().filter((d) => inFlight(downloads.status(d).state))
        : [],
  );
  const stagedWatchlist = $derived(
    stagedHome
      ? stagedHome.view.watchlist.flatMap((key) => {
          const ref = refOfKey(key);
          return ref ? (session.displayTitle(ref) ?? []) : [];
        })
      : [],
  );
  const liveClock = (entry: ContinueEntry) => {
    const at = livePosition(entry, now);
    return at === undefined ? undefined : timecode(at);
  };

  /** The title whose page is open, if one is. */
  const page = $derived(route.page === 'title' ? { type: route.type, id: route.id } : null);

  // A route the viewer chose is foreground work. This removes it from the idle tail, or joins the exact pending
  // request when an idle slot got there first.
  $effect(() => {
    const opening = page;
    const key = tmdbKey;
    // Re-run when the post-shelf tail is created, including a directly opened route with no pointer intent.
    void historyNaming;
    void shelfNaming;
    if (active && opening && key) void promoteLibraryTitle(session, opening, key);
  });

  // A screen Home doesn't draw loads when this page is it (`screens.svelte.ts`).
  $effect(() => {
    if (page) void DetailScreen.load();
    else if (route.page === 'person') void PersonScreen.load();
    else if (route.page === 'search') void SearchScreen.load();
    else if (route.page === 'people') void PeopleScreen.load();
    else if (route.page === 'downloads') void DownloadsScreen.load();
    else if (route.page === 'service') void ServiceScreen.load();
    else if (route.page === 'watchlist') void WatchlistScreen.load();
  });
  $effect(() => {
    if (playing) void PlayerScreen.load();
  });
  const pageRow = $derived.by(() => {
    void version;
    return page ? log?.title(page) : undefined;
  });
  const pageEpisodes = $derived.by(() => {
    void version;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- This derived value publishes a completed snapshot; intermediate inserts must not be reactive.
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
    session.rememberTitle(title);
  }

  const actionLog = () => (log ? Promise.resolve(log) : session.ensureLog());

  /** Write one row and re-derive what shows it. */
  async function save(row: Row, journal = false) {
    const opened = await actionLog();
    if (!opened) return;
    busy = true;
    failure = null;
    try {
      const saved =
        journal && row.kind === 'set' ? await opened.writeAction(row) : await opened.write(row);
      if (opened.moved) {
        if (link) links.forgetMoved(link);
        return;
      }
      if (!saved) failure = SAVE_FAILED;
      else if (opened.pendingActions > 0)
        notice =
          'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.';
      session.changed();
      return saved !== null;
    } catch {
      failure = SAVE_FAILED;
      return false;
    } finally {
      busy = false;
    }
  }

  /** A title's row as last read, for the billboard's Watchlist and Seen. */
  const rowOf = (title: Title) => {
    void version;
    return log?.title(title);
  };

  /** A press on a billboard slide: the slide says when it didn't save, so the page doesn't say it again. */
  async function fromSlide(write: Promise<boolean | undefined>) {
    const saved = await write;
    failure = null;
    return saved;
  }

  /** Apply an action to the title's row as last read (or a blank one), stamped now, and write it. */
  async function act(title: Title, change: (row: TitleRow, at: Stamp) => TitleRow) {
    const opened = await actionLog();
    if (!opened) return;
    try {
      await ensureSyncPolicy();
      remember(title);
      const before = opened.title(title) ?? blankTitle(title, Date.now());
      clock.see(opened.newestStamp());
      const at = clock.issue();
      const event = recordTrackerEvent(before, change(before, at), at);
      return event ? await save(event, true) : true;
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  /**
   * Off Continue Watching. Not an action the trackers hear about — nothing about what was watched changed, and the
   * TV's own dismissal sends nothing either — so the row itself is written rather than a tracker event, which the
   * sync policy doesn't capture for this change and `act` would then drop.
   */
  async function dismiss(title: Title) {
    const opened = await actionLog();
    if (!opened) return;
    try {
      // Stamping runs through the sync policy, as for every other action: without it loaded the dismissal throws.
      await ensureSyncPolicy();
      remember(title);
      const before = opened.title(title) ?? blankTitle(title, Date.now());
      clock.see(opened.newestStamp());
      if (!(await save(dismissFromContinueWatching(before, clock.issue())))) {
        // Unlike the actions around it, a row write isn't kept on this device to sync later.
        failure =
          'Couldn’t remove that from Continue Watching. It needs a connection to your library.';
        return false;
      }
      return true;
    } catch (error) {
      console.warn('den: removing from Continue Watching failed', error);
      failure = SAVE_FAILED;
      return false;
    }
  }

  /** Undoes `dismiss` — the poster menu's "Remove from Continue Watching" offers this in its toast. */
  async function restore(title: Title) {
    const opened = await actionLog();
    if (!opened) return;
    try {
      await ensureSyncPolicy();
      remember(title);
      const before = opened.title(title) ?? blankTitle(title, Date.now());
      clock.see(opened.newestStamp());
      return await save(restoreToContinueWatching(before, clock.issue()));
    } catch (error) {
      console.warn('den: restoring to Continue Watching failed', error);
      return false;
    }
  }

  /**
   * Unlike every other library write here, this one has no toast of its own (den-edge#258): the episode row
   * that triggered it is usually far below the hero where `failure` renders, so a refusal was invisible — the
   * press looked like it did nothing, because from here down the page nothing visibly did. `session.notify`
   * puts the same word where the press happened, as the poster ⋯ menu's own writes already do.
   */
  async function markEpisodeSeen(title: Title, season: number, episode: number, seen: boolean) {
    const opened = await actionLog();
    if (!opened) return false;
    try {
      await ensureSyncPolicy();
      remember(title);
      const row = opened.episode(title, season, episode) ?? blankEpisode(title, season, episode);
      clock.see(opened.newestStamp());
      const at = clock.issue();
      const event = recordTrackerEvent(row, markEpisode(row, seen, at), at);
      const ok = event ? await save(event, true) : true;
      if (!ok) session.notify(SAVE_FAILED);
      return ok;
    } catch {
      failure = SAVE_FAILED;
      session.notify(SAVE_FAILED);
      return false;
    }
  }

  /** Same regular-season/last-aired expansion as DenKit.SeriesProgress.airedEpisodes. */
  async function setSeen(title: Title, seen: boolean) {
    const opened = await actionLog();
    if (!opened) return;
    try {
      await ensureSyncPolicy();
      if (title.type === 'tv') {
        const shape =
          session.shapes.get(titleKey(title)) ?? (await fetchDetails(title, tmdbKey))?.shape;
        if (!shape) {
          failure = 'Couldn’t load the episodes. Nothing was marked Seen.';
          return false;
        }
        const journals: SettingsRow[] = [];
        clock.see(opened.newestStamp());
        for (const [season, count] of [...shape.counts].sort((a, b) => a[0] - b[0])) {
          if (season <= 0) continue;
          for (let episode = 1; episode <= count; episode++) {
            if (!isAired({ season, episode }, shape.lastAired)) continue;
            const before =
              opened.episode(title, season, episode) ?? blankEpisode(title, season, episode);
            const at = clock.issue();
            const event = recordTrackerEvent(before, markEpisode(before, seen, at), at);
            if (event) journals.push(event);
          }
        }
        const before = opened.title(title) ?? blankTitle(title, Date.now());
        const at = clock.issue();
        const event = recordTrackerEvent(
          before,
          (seen ? markWatched : unwatchSeries)(before, at),
          at,
        );
        if (event) journals.push(event);
        busy = true;
        failure = null;
        try {
          if (!(await opened.writeActions(journals))) failure = SAVE_FAILED;
          else if (opened.pendingActions > 0)
            notice =
              'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.';
          session.changed();
        } catch {
          failure = SAVE_FAILED;
        } finally {
          busy = false;
        }
        return failure === null;
      }
      return await act(title, seen ? markWatched : unwatch);
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  /**
   * Mark a whole season, in one write rather than one per episode.
   *
   * `markEpisodeSeen` seals, stores and posts once per call, so a ten-episode season through it is twenty
   * requests and ten records in this browser's storage — which `pendingActions` then scans. `writeActions`
   * seals them together, keeps them as one record and delivers them in batches, which is what marking a
   * whole series already does.
   *
   * The title's own row is deliberately left alone. A season is not the series, and the series-wide
   * un-mark works by `episodesReset`, which cannot say "this season only".
   */
  async function markSeasonSeen(title: Title, season: number, episodes: number[], seen: boolean) {
    if (!episodes.length) return;
    const opened = await actionLog();
    if (!opened) return;
    busy = true;
    failure = null;
    try {
      await ensureSyncPolicy();
      remember(title);
      const journals: SettingsRow[] = [];
      clock.see(opened.newestStamp());
      for (const episode of episodes) {
        const before =
          opened.episode(title, season, episode) ?? blankEpisode(title, season, episode);
        // A stamp each: one shared across the rows would lose the order they merge in.
        const at = clock.issue();
        // An episode already in this state journals nothing, and drops out of the write by itself.
        const event = recordTrackerEvent(before, markEpisode(before, seen, at), at);
        if (event) journals.push(event);
      }
      if (!journals.length) return;
      if (!(await opened.writeActions(journals))) failure = SAVE_FAILED;
      else if (opened.pendingActions > 0)
        notice =
          'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.';
      session.changed();
    } catch {
      failure = SAVE_FAILED;
    } finally {
      busy = false;
    }
  }

  /**
   * Start the title on the linked TV, as the TV's own Play would — it picks the source.
   *
   * Undefined for a guest, and that is the enforcement: `sendToTV` needs the link's own keys, so with no
   * link there is nothing to pass and this cannot be constructed at all. A missing callback, which the
   * type checker insists on, rather than a callback that declines at runtime.
   *
   * Feedback from here on is the bottom toast (`playOnTv`), not `notice` — the press can be far from where
   * `notice` shows (an `EpisodeCard` up the page), and the toast is where it is seen.
   */
  const play = $derived(
    link
      ? async (title: Title, season?: number, episode?: number) => {
          busy = true;
          failure = null;
          const blocked = await playGuard(title, {
            tmdbKey,
            region: detailPrefs.region,
            ceiling: detailPrefs.ceiling,
          });
          if (blocked) {
            busy = false;
            failure = blocked;
            session.notify(blocked);
            return;
          }
          const sealed = await sendToTV(link, {
            type: 'play',
            tmdbId: title.id,
            mediaType: title.type,
            title: title.title,
            season,
            episode,
          });
          busy = false;
          if (sealed)
            playOnTv.start(link, sealed, link.name ?? 'your TV', {
              type: title.type,
              id: title.id,
            });
          else failure = 'Couldn’t reach your TV. Check that this device is on your network.';
        }
      : undefined,
  );

  /**
   * Play in this browser, through den-remux: needs scout, for the release, and TMDB, for its IMDb id. A series with
   * no episode named picks up where Continue Watching would, or starts at the beginning.
   */
  const playHere = $derived(
    scout && tmdbKey && remux !== null
      ? async (title: Title, season?: number, episode?: number, filename?: string) => {
          const blocked = await playGuard(title, {
            tmdbKey,
            region: detailPrefs.region,
            ceiling: detailPrefs.ceiling,
          });
          if (blocked) {
            failure = blocked;
            session.notify(blocked);
            return;
          }
          if (title.type === 'tv' && (season === undefined || episode === undefined)) {
            const up = continueEntries.find((e) => titleKey(e.title) === titleKey(title))?.episode;
            playing = { title, ...(up ?? { season: 1, episode: 1 }) };
          } else {
            playing = { title, season, episode, filename };
          }
        }
      : undefined,
  );

  // The poster ⋯ menu (den-edge#236): the same handlers above, reached by context rather than threaded as
  // props through every row and page that draws a `PosterCard`. A write it makes announces its result through
  // the page toast, the one `LibrarySession.notify` already shows for other library news.
  setToastContext((message, undo) => session.notify(message, { undo }));
  function menuToast(
    ok: boolean | undefined,
    success: string,
    undo?: { label: string; run: () => void },
  ) {
    if (ok) session.notify(success, { undo });
    else if (ok === false) session.notify(SAVE_FAILED);
  }
  setTitleActionsContext({
    get libraryOpen() {
      return !!log || !!stagedHome;
    },
    get busy() {
      return busy;
    },
    rowOf,
    resumeOf: (title) =>
      title.type === 'tv'
        ? continueEntries.find((e) => titleKey(e.title) === titleKey(title))?.episode
        : undefined,
    toggleWatchlist: (title, on) => {
      void act(title, on ? addToWatchlist : removeFromLibrary).then((ok) =>
        menuToast(
          ok,
          on
            ? `Added “${title.title}” to your watchlist`
            : `Removed “${title.title}” from your watchlist`,
          on ? undefined : { label: 'Undo', run: () => void act(title, addToWatchlist) },
        ),
      );
    },
    toggleSeen: (title, seen) => {
      void setSeen(title, seen).then((ok) =>
        menuToast(
          ok,
          seen ? `Marked “${title.title}” as seen` : `Marked “${title.title}” as unseen`,
        ),
      );
    },
    setReaction: (title, reaction) => {
      const label =
        reaction === 'like'
          ? 'Like'
          : reaction === 'love'
            ? 'Love'
            : reaction === 'dislike'
              ? 'Not for me'
              : 'No rating';
      void act(title, (row, at) => react(row, reaction, at)).then((ok) =>
        menuToast(ok, `Set “${title.title}” to ${label}`),
      );
    },
    dismissContinueWatching: (title) => {
      void dismiss(title).then((ok) =>
        menuToast(ok, `Removed “${title.title}” from Continue Watching`, {
          label: 'Undo',
          run: () => void restore(title),
        }),
      );
    },
    get play() {
      return play;
    },
    get playHere() {
      return playHere;
    },
  });

  /** The aired episode after the one playing, from the series' season layout; none after a movie or the last. */
  let following = $state<Target | null>(null);
  $effect(() => {
    const target = playing;
    following = null;
    if (!target || target.season === undefined || target.episode === undefined) return;
    const at = { season: target.season, episode: target.episode };
    void (async () => {
      const shape =
        session.shapes.get(titleKey(target.title)) ??
        (await fetchDetails(target.title, tmdbKey))?.shape;
      const next = shape && episodeAfter(at, shape);
      if (playing === target && next && isAired(next, shape.lastAired))
        following = { title: target.title, ...next };
    })();
  });

  function progressOf(target: Target) {
    const { title, season, episode } = target;
    return season !== undefined && episode !== undefined
      ? log?.episode(title, season, episode)?.progress
      : log?.title(title)?.resume;
  }

  /** Where the library says the target was left: nowhere once it was seen, so it plays from the start. */
  function resumePoint(target: Target): { fraction: number; seconds?: number } {
    const progress = progressOf(target);
    return progress && progress.value < WATCHED
      ? { fraction: progress.value, seconds: progress.seconds }
      : { fraction: 0 };
  }

  /** Where playback got to, written as the TV's player writes it. */
  async function progressed(target: Target, fraction: number, seconds: number) {
    const opened = await actionLog();
    if (!opened) return;
    try {
      await ensureSyncPolicy();
      const { title, season, episode } = target;
      remember(title);
      if (season !== undefined && episode !== undefined) {
        const row = opened.episode(title, season, episode) ?? blankEpisode(title, season, episode);
        await save(updateEpisodeProgress(row, fraction, seconds, clock.issue()));
      } else {
        await save(
          updateProgress(
            opened.title(title) ?? blankTitle(title, Date.now()),
            fraction,
            seconds,
            clock.issue(),
          ),
        );
      }
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  /**
   * Start reel resolving this title's trailer before the page that wants it exists.
   *
   * The resolve is a couple of seconds of yt-dlp and it used to begin only once the detail hero
   * asked — after the page had mounted and TMDB had answered — so the wait was serial and entirely
   * visible. Atlas gives rows an IMDb id of their own, so nothing has to be looked up first: the tap
   * is enough to start it, and it runs while the page is still being built.
   *
   * Fire and forget. It is a warm-up; reel caches the answer either way, and `trailerCandidates`
   * reports a failure as an empty list rather than throwing.
   */
  function warmTrailer(title: { type: Title['type']; id: number; imdbId?: string }) {
    // Promote a watched-history title at pointer intent, before navigation mounts its detail route. The naming
    // run owns de-duplication, so the route effect and an already-running idle request join this same key.
    if (tmdbKey) void promoteLibraryTitle(session, title, tmdbKey);
    // The page itself, before its trailer. `preloadScreens` fetches this chunk once Home is idle, so
    // it is usually resident already — but a press within the first second of a visit landed on the
    // route-level spinner while it downloaded. Idempotent: a second call joins the first.
    void DetailScreen.load();
    // No imdb id needed any more: reel takes the tmdb id every title has, and is told the imdb one when
    // we happen to hold it. A title whose imdb id was never fetched used to get no trailer at all.
    if (!reel) return;
    void trailerCandidates(reel, title.type, { tmdb: title.id, imdb: title.imdbId }, routes, {
      prewarm: 'direct',
      // Combined discovery + source preparation saves the dependent `/meta` -> `/sources` RTT. A
      // pre-prepare Reel falls back inside `trailerCandidates`; the detail page then asks the named
      // `/sources` URL exactly as it did before.
      sourceAsk: {
        surface: 'audible',
        player: nativeHls() ? 'native' : 'hls.js',
        // A press is a guess, not a decision. Without this reel builds the hero's FALLBACK index for
        // it — roughly forty-five range requests to Google — for a rung the master makes unnecessary,
        // and it does so for every title glanced at across rows, search results and filmographies. The
        // resolve still starts, which is the expensive half and the half that actually helps.
        intent: 'warm',
      },
    }).then((found) => {
      const first = found[0];
      if (!first?.sources || Object.hasOwn(first, 'prepared')) return;
      // A Reel version predating `/prepare`: preserve its two-request warm path during a mixed
      // rollout. Once the server upgrades, the combined response above makes this branch disappear.
      void fetchSources(first.sources, {
        surface: 'audible',
        player: nativeHls() ? 'native' : 'hls.js',
        intent: 'warm',
      });
    });
  }

  // Every link to a title warms its trailer as the pointer goes down, before the click has even landed — one
  // listener at the document rather than a callback threaded through every row, card and screen, and it covers
  // links this file has never heard of.
  $effect(() => warmOnIntent(warmTrailer));
  /**
   * What is already known about the title being opened — its artwork, for the hero to paint while
   * TMDB is asked. Everything on screen has been named through `session.displays`, so the row or
   * billboard the viewer just pressed is holding exactly this.
   */
  const pageSeed = $derived.by(() => {
    const opening = page;
    if (!opening) return undefined;
    const here = (t: Title) => t.type === opening.type && t.id === opening.id;
    // The billboard, then anything named through the library, then the card that was pressed: a browse
    // row's titles are loaded inside the row itself, and the card says what it held (`notePressed`).
    return featured.find(here) ?? session.displays.find(here) ?? pressedCard(opening)?.title;
  });
  /** The pressed card's own poster, already loaded, which the hero paints at once while TMDB is asked. */
  const pageStill = $derived(page ? pressedCard(page)?.still : undefined);

  /** The TV's hide rules, from the log's `set:prefs`: re-read when settings change, not on every refresh. */
  const prefs = $derived.by(() => {
    void session.settingsRevision;
    if (stagedHome) {
      const compact = stagedHome.settings.prefs;
      return {
        ...compact,
        excludedGenres: new Set(compact.excludedGenres),
        excludedLanguages: new Set(compact.excludedLanguages),
      };
    }
    return readPrefs(log?.settings('prefs'));
  });
  const detailPrefs = $derived.by(() => {
    void session.settingsRevision;
    return readDetailPrefs(log?.settings('prefs'));
  });
  /** Settings › Playback's languages, which the player here asks den-remux for. */
  const playbackPrefs = $derived.by(() => {
    void session.settingsRevision;
    return readSyncedPrefs(log?.settings('prefs'));
  });
  const warningKey = $derived.by(() => {
    void session.settingsRevision;
    return readApiKey(log?.settings('keys'), 'doesthedogdie') ?? '';
  });
  const omdbKey = $derived.by(() => {
    void session.settingsRevision;
    return readApiKey(log?.settings('keys'), 'omdb') ?? '';
  });
  const shown = (title: Title) => !isHidden(title, prefs);
  /** What the TV's discovery rows hide: its rules, and what you've seen when Hide Watched is on. */
  const watched = $derived(
    new Set(
      stagedHome
        ? stagedHome.view.watched
        : (applied?.records
            .filter((r) => !r.deleted && r.status === 'watched')
            .map((r) => titleKey(r.title)) ?? []),
    ),
  );
  const browseShown = (title: Title) =>
    shown(title) && !(prefs.hideWatched && watched.has(titleKey(title)));
  /**
   * A service tile is about to be opened: fetch its screen's code and start the page's own requests, which the page
   * joins when it mounts. Only once atlas discovery has answered, since the page asks nothing before that either and
   * a guess made without it would be a different page.
   */
  function primeService(service: Service, country: string) {
    void ServiceScreen.load();
    if (!tmdbKey || !atlasReady) return;
    primeServicePage(service, country, tmdbKey, atlas, {
      minYear: prefs.minReleaseYear,
      excludedLanguages: prefs.excludedLanguages,
      shown: browseShown,
    });
  }
  /**
   * What a title's OWN rows hide — "You might also like", its collection, its cast's other work.
   *
   * The discovery rules do not apply here. A year floor and Hide Watched shape what to show you NEXT; on a
   * title's page you are asking what RESEMBLES this, so an old film or one you have already seen is a
   * legitimate answer, and dropping it leaves a short row with nothing saying why.
   *
   * The content rules still do: an adult title, a hidden genre or language, and a card with no poster stay
   * hidden, because those say what you do not want to see at all rather than what to show you next.
   * So this does NOT explain a missing neighbour that sits in an excluded genre — Begin Again is absent
   * from Once's row because Once's genres are hidden, and only unhiding them brings it back.
   */
  const relatedShown = (title: Title) => !isHidden(title, prefs, { ignoringYearFloor: true });
  /** The billboard's own rule: everything the rows hide, except the missing poster it doesn't draw. */
  const featuredShown = (title: Title) =>
    !isHidden(title, prefs, { requirePoster: false }) &&
    !(prefs.hideWatched && watched.has(titleKey(title)));
  /**
   * Every title the library holds with how much it says about taste. Watched and part-watched titles are a verdict
   * and count full; a watchlisted one is an intention and counts for less; a reaction is the one thing said outright,
   * so it counts for more than either, and a dislike counts against. Ids and weights need no names.
   */
  const weighted = $derived.by(() => {
    if (stagedHome)
      return stagedHome.view.weighted.map(([key, weight, at]) => {
        const ref = refOfKey(key)!;
        return { ref, weight, at };
      });
    // Reactions live on the log's rows; the records carry only status. A title is read by both.
    const reactions = personalTitleRows.reactions;
    const weightOf = (status: string, reaction: string | null | undefined) => {
      // Turning something down is the whole verdict; that they sat through it doesn't soften it.
      if (reaction === 'dislike') return -1.5;
      const seen =
        status === 'watched' || status === 'inProgress' ? 1 : status === 'watchlist' ? 0.6 : 0;
      return seen + (reaction === 'love' ? 1 : reaction === 'like' ? 0.5 : 0);
    };
    return (applied?.records ?? []).flatMap((r) => {
      if (r.deleted) return [];
      const weight = weightOf(r.status, reactions.get(titleKey(r.title)));
      return weight === 0
        ? []
        : [
            {
              ref: { type: r.title.type, id: r.title.id },
              weight,
              at: Math.max(r.progressAt, r.addedAt),
            },
          ];
    });
  });
  /** The browse screens' rows, headers now and posters as each nears the screen. */
  const pages = $derived(tmdbKey ? tmdbPages(tmdbKey) : null);
  /** The seeds of Home's personal rows: your two latest watched or liked titles, and two latest watchlisted, named. */
  const seeds = $derived.by(() => {
    if (stagedHome) {
      const named = (keys: string[]) =>
        keys.flatMap((key) => {
          const ref = refOfKey(key);
          return ref ? (session.displayTitle(ref) ?? []) : [];
        });
      return {
        watched: named(stagedHome.view.seeds.watched),
        watchlisted: named(stagedHome.view.seeds.watchlisted),
        owned: new Set(stagedHome.view.owned),
      };
    }
    const { selected, titleRows } = personalTitleRows;
    const namedSeeds = (refs: TitleRow[]) =>
      refs.flatMap((r) => session.displayTitle(r.title) ?? []);
    return {
      watched: namedSeeds(selected.watched),
      watchlisted: namedSeeds(selected.watchlisted),
      owned: new Set(titleRows.map((r) => titleKey(r.title))),
    };
  });
  // Opt-in development proof: the Worker selects the compact fixed Home inputs while it already owns the fold;
  // compare them with the values this component still derives today. Production omits and never reads the proof.
  // Enable with VITE_HOME_VIEW_PROOF=1; ordinary development should not pay for the extra clone and comparison.
  $effect(() => {
    if (
      !import.meta.env.DEV ||
      import.meta.env.VITE_HOME_VIEW_PROOF !== '1' ||
      !projection ||
      !applied
    )
      return;
    const worker = devHomeLibraryView(projection.rows);
    if (!worker) return;
    const current = homeLibraryViewFromCurrent({
      library: applied,
      rows: projection.rows,
      ...personalTitleRows,
      watched,
      watchlist: applied.records
        .filter((record) => !record.deleted && record.status === 'watchlist')
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((record) => titleKey(record.title)),
      standings: standings(applied),
      weighted,
    });
    const digest = digestHomeLibraryView(current);
    if (
      digest.hash !== worker.digest.hash ||
      digest.bytes !== worker.digest.bytes ||
      JSON.stringify(current) !== JSON.stringify(worker.view)
    )
      console.warn('den: Worker Home view differs from the page projection', {
        worker,
        current: { view: current, digest },
      });
  });
  /**
   * atlas's service charts, as its manifest lists them: what the pooled rows can be built from at all.
   *
   * Which services have a "new" or a "coming" chart is atlas's to say and changes with its releases, so the rows
   * are only ever as broad as the manifest — and where it lists none, there are no rows rather than empty ones.
   */
  let serviceCatalogs = $state<AtlasCatalog[]>([]);
  $effect(() => {
    const here = atlas;
    if (!here) return;
    let current = true;
    void atlasCatalogs(here).then(
      (listed) => {
        if (current) serviceCatalogs = listed;
      },
      () => {
        // atlas down or unreachable: the screen is what it was before atlas had charts.
      },
    );
    return () => {
      current = false;
    };
  });
  /** The pooled rows for this screen: what has just landed on the viewer's services, and what is about to. */
  const radar = (only?: 'movie' | 'tv') =>
    atlas
      ? radarRows(atlas, serviceCatalogs, servicePicks, {
          only,
          names: serviceNames,
          tmdbKey: tmdbKey ?? undefined,
        })
      : [];
  const rows = $derived.by(() => {
    if (!pages) {
      // No TMDB key, so no TMDB rows — a guest, until the server-side key lands. atlas needs no key at all:
      // its rows carry their own titles, posters and ids, and the poster images come from a CDN that asks
      // for none. Without this a guest's home is simply blank, which is what it was.
      if (!atlas) return [];
      // The pooled rows need no key either — atlas's charts carry their own titles — so a visitor gets them too.
      if (route.page === 'movies' || route.page === 'series') {
        const type = route.page === 'movies' ? 'movie' : 'tv';
        return [...radar(type), ...atlasRows(atlas, type)];
      }
      return [...radar(), ...interleave([atlasRows(atlas, 'movie'), atlasRows(atlas, 'tv')])];
    }
    const minYear = prefs.minReleaseYear;
    // The genre, recipe, decade and country rows ask atlas's filter first, TMDB where it can't answer.
    const key = tmdbKey;
    const filter = atlas
      ? { base: atlas, title: (ref: { type: 'movie' | 'tv'; id: number }) => fetchTitle(ref, key) }
      : undefined;
    if (route.page === 'movies' || route.page === 'series') {
      const type = route.page === 'movies' ? 'movie' : 'tv';
      const browse = browseRows(type, pages, {
        minYear,
        hiddenGenres: prefs.excludedGenres,
        excludedLanguages: prefs.excludedLanguages,
        atlas: filter,
      });
      // After Popular and the three genre rows, atlas's rows take turns with TMDB's categories and lead each
      // round, as the TV's index rows do: they say something a genre or a decade doesn't.
      const own = atlas ? atlasRows(atlas, type) : [];
      return [...browse.slice(0, 4), ...radar(type), ...interleave([own, browse.slice(4)])];
    }
    // Home's spine and recipe rows (seven), then atlas's three strongest film rows before the categories.
    //
    // What has just landed on this household's services does not get a row of its own here: it leads New
    // Releases, which was asking the same question of TMDB and meaning the release date by it. What is still
    // to come has no such twin, so it stays a row.
    const home = homeRows(pages, {
      minYear,
      excludedLanguages: prefs.excludedLanguages,
      atlas: filter,
    });
    const plot = atlas ? atlasRows(atlas, 'movie').slice(0, 3) : [];
    const pooled = radar();
    const arrivals = pooled.find((row) => row.id.startsWith('radar-new'));
    const spine = arrivals
      ? home.map((row) => (row.id === 'new-releases' ? mergeNewRow(arrivals, row) : row))
      : home;
    const coming = pooled.filter((row) => row !== arrivals);
    return [
      ...personalRows(pages, seeds),
      ...spine.slice(0, 2),
      ...coming,
      ...spine.slice(2, 7),
      ...plot,
      ...spine.slice(7),
    ];
  });
  /**
   * The services Home shows as brand tiles: the household's own picks, or — until a library has any — the six a
   * visitor is shown. A pick names a country as well as a service, because a catalogue is licensed per country.
   */
  const servicePicks = $derived(prefs.servicesConfigured ? prefs.services : GUEST_PICKS);
  /** Which countries have been asked for; a directory is one request per country per visit, not one per pick. */
  const askedFor: Record<string, true> = {};
  let directories = $state<Record<string, Service[]>>({});
  /** Countries whose directory is on its way: the Services row holds its room until they answer. */
  let naming = $state(0);
  $effect(() => {
    if (!tmdbKey) return;
    for (const { country } of servicePicks) {
      if (askedFor[country]) continue;
      askedFor[country] = true;
      naming++;
      void fetchServices(country, tmdbKey)
        .then(
          (listed) => {
            directories = { ...directories, [country]: listed };
          },
          () => {
            // No directory, no tiles — but the country is put back, so the next visit to Home asks again rather
            // than leaving the row empty for the rest of the session over one failed request.
            delete askedFor[country];
          },
        )
        .finally(() => naming--);
    }
  });
  /** The picks their country's directory can account for, named and ordered by it. */
  const services = $derived(
    [...new Set(servicePicks.map((pick) => pick.country))].flatMap((country) =>
      resolvePicks(servicePicks, directories[country] ?? [], country),
    ),
  );
  /**
   * Provider id → the name its country's directory gives it, for a pooled row's captions. Every id a service
   * folds in maps to the one name, so a title listed under "Netflix Standard with Ads" still reads "Netflix".
   * A visitor has no directory and so no names: their cards say when a title lands, not where.
   */
  const serviceNames: Record<number, string> = $derived(
    Object.fromEntries(
      services.flatMap(({ service }) =>
        [service.id, ...service.variants].map((id) => [id, service.name]),
      ),
    ),
  );
  /** The screen's own facet: Movies shows your movies, Series your series, Home both. */
  const facet = $derived(route.page === 'movies' ? 'movie' : route.page === 'series' ? 'tv' : null);
  /**
   * What the billboard cycles. Not a row: a pool ranked by atlas (`buildRecommended`) — what is being watched now,
   * what is new or still to come, and what has just landed on this household's own services, away from anything the
   * library already holds.
   */
  let featured = $state<RecommendedTitle[]>([]);
  let heroReady = $state(false);
  const heroKey = $derived(
    featured[0] ? `${facet ?? 'all'}:${featured[0].type}:${featured[0].id}` : '',
  );
  $effect(() => {
    void heroKey;
    heroReady = false;
  });
  /** Which build of the billboard is the current one: a slower earlier one must not overwrite a later answer. */
  let billboardRun = 0;
  /** Where the billboard picked for a facet is kept for the next visit (`LibraryLog.keep`). */
  // v4 invalidates the additive blend that let an unmatched shared lead stay ahead of credible personal matches.
  // Earlier namespaces cover the unbounded multi-seed and removed POST rankers.
  // Only-new-titles billboards (`fresh`) are kept under names of their own, so neither opens the other's page.
  const keptBillboard = (type: 'movie' | 'tv' | null) =>
    `billboard.v4.${fresh ? 'fresh.' : ''}${type ?? 'all'}`;
  /** Where atlas's ranking for this library (`POST /recommend`) is kept, with when it was ranked (`KeptBillboard`). */
  const keptPersonal = (type: 'movie' | 'tv' | null) =>
    `billboard.personal.v1.${fresh ? 'fresh.' : ''}${type ?? 'all'}`;
  /**
   * Read once per page: whether a library's billboard is ranked by atlas against it (`memberPostOn`), and whether
   * the billboard is only new titles (`freshOn`).
   */
  const memberPost = memberPostOn();
  const fresh = freshOn();
  /** The title on the billboard's screen, which a new ranking leaves in place. */
  let slideShown = $state<Title>();
  // A return visit shows the billboard it picked last time as soon as the library opens: this visit's build waits
  // for atlas and TMDB, and the page shouldn't. With the member switch on, only atlas's ranking for this library
  // opens it for up to seven days. After its first day it is stale-while-revalidate: it still paints immediately,
  // while the ranking already requested below replaces it in the background. Older rankings use the shared one.
  $effect(() => {
    const opened = log;
    const staged = stagedHome;
    const type = facet;
    if ((!opened && !staged) || !tmdbKey) return;
    if (memberPost) {
      void session.kept<KeptBillboard>(keptPersonal(type)).then((saved) => {
        const titles = displayableKept(saved)?.titles ?? null;
        if (titles && !featured.length) featured = titles;
      });
      return;
    }
    void session.kept<RecommendedTitle[]>(keptBillboard(type)).then((saved) => {
      if (saved?.length && !featured.length) featured = saved;
    });
  });
  // Common next screens load only after both the shelves and the hero have won their critical resources.
  $effect(() => {
    if (!shelvesReady || !heroReady) return;
    preloadScreens();
    const timer = setTimeout(() => session.foregroundReady(), PROVIDERS_AFTER_HERO_MS);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    // What the billboard is rebuilt FOR: which page this is, where atlas answers, and whether TMDB can be
    // asked at all. Everything else it reads — the rows, the library's shape, the hide rules, the taste — is
    // read without being watched. Those tick over continuously while the library is named, and watching them
    // had the whole pool rebuilt on every tick: hundreds of repeat requests to atlas for one page load.
    if (
      route.page === 'title' ||
      route.page === 'person' ||
      route.page === 'search' ||
      route.page === 'people' ||
      route.page === 'watchlist' ||
      route.page === 'downloads' ||
      route.page === 'service'
    )
      return;
    const here = atlas;
    if (!tmdbKey) return;
    // The shared pool needs no profile read: ask as soon as discovery and TMDB naming are available. `null` is a
    // guest with no log; a paired/local library is ready when `applied` is not null.
    if (!here) {
      untrack(() => buildTrending(++billboardRun));
      return;
    }
    if (log === null || libraryOpen) untrack(() => buildRecommended(here));
  });

  /** Whether the log's rows have been read: once, rather than every time they change. */
  const libraryOpen = $derived(applied !== null || stagedHome !== null);

  /**
   * Everyone starts with atlas's one cacheable ranking for this surface and UTC day, less what the library holds.
   * Naming is in two waves so the lead's backdrop starts after one TMDB lookup instead of waiting for the slowest of
   * twenty.
   *
   * With the member switch on, a library's billboard is then ranked by atlas against the whole library, asked at
   * once and applied once the first paint is up. A kept ranking up to seven days old is that first paint instead of
   * the shared one; after day one it is stale while this request revalidates it. The new ranking takes every slide
   * after the one on screen and is kept for the next visit.
   */
  function buildRecommended(here: string) {
    const type = facet;
    const key = tmdbKey;
    const run = ++billboardRun;
    const opened = log;
    const lookup = (ref: { type: 'movie' | 'tv'; id: number }) => fetchTitle(ref, key);
    const ranked =
      (opened || stagedHome) && memberPost
        ? recommend(
            here,
            recommendBody({
              facet: type,
              prefs,
              library: weighted,
              named: session.displayTitles(),
              owned: seeds.owned,
              fresh,
            }),
          )
        : null;
    const kept = ranked
      ? session.kept<KeptBillboard>(keptPersonal(type)).then(
          (saved) => displayableKept(saved)?.titles ?? null,
          () => null,
        )
      : Promise.resolve(null);
    void kept
      .then(async (personal) => {
        if (run !== billboardRun) return;
        if (personal) {
          if (!featured.length) featured = personal;
        } else await paintShared(here, run);
        const slides = await ranked;
        if (run !== billboardRun || !slides?.length) return;
        const known = new Map(featured.map((title) => [titleKey(title), title] as const));
        const picked = await nameSlides(slides.slice(0, EVERYONE_NAMED), known, lookup, LOOKUPS);
        if (run !== billboardRun || !picked.length) return;
        featured = swapAfter(featured, slideShown, picked);
        if (opened || stagedHome) {
          const keptAt = Date.now();
          void replacePersonalBillboard(
            libraryIdentity,
            type,
            fresh,
            picked,
            (kept) => session.keep(keptPersonal(type), kept),
            keptAt,
          ).catch(warnKeep);
        }
      })
      .catch(() => buildTrending(run));
  }

  /** The shared billboard (`GET /recommend/<scope>.json`) as the first paint, less what the library holds. */
  async function paintShared(here: string, run: number) {
    const type = facet;
    const key = tmdbKey;
    const shared = (await recommendForEveryone(here, billboardScope(type), fresh))?.filter(
      (slide) => !seeds.owned.has(`${slide.type}:${slide.id}`),
    );
    if (run !== billboardRun) return;
    if (!shared?.length) {
      buildTrending(run);
      return;
    }
    const lookup = (ref: { type: 'movie' | 'tv'; id: number }) => fetchTitle(ref, key);
    const first = await nameSlides(shared.slice(0, 1), new Map(), lookup, 1);
    if (run !== billboardRun) return;
    // A member's kept billboard stays up while the rest is named. A guest's generic fallback gives way at once.
    if (first.length && (!libraryOpen || !featured.length)) featured = first;
    const known = new Map(first.map((title) => [titleKey(title), title] as const));
    const picked = await nameSlides(shared.slice(0, EVERYONE_NAMED), known, lookup, LOOKUPS);
    if (run !== billboardRun) return;
    if (!picked.length) {
      buildTrending(run);
      return;
    }
    // Replacing the kept paint is essential: keeping its old first slide made a pre-GET recommendation lead
    // forever, with its stale explanation attached.
    featured = picked;
    if (log || stagedHome) void session.keep(keptBillboard(type), picked).catch(warnKeep);
  }

  /**
   * The billboard without atlas's ranking — no atlas found yet, or one that can't rank: what is trending now (Home)
   * or popular (Movies, Series) as TMDB orders it, less what the library holds and what the hide rules hide. Only
   * where nothing is showing yet: a kept or ranked billboard stays.
   */
  function buildTrending(run: number) {
    const type = facet;
    const row = rows.find((r) => r.id === 'trending' || r.id === 'popular');
    void (row?.load(1) ?? Promise.resolve([]))
      .catch((): Title[] => [])
      .then((titles) => {
        if (run !== billboardRun || featured.length) return;
        featured = titles
          .filter(
            (t) => featuredShown(t) && !seeds.owned.has(titleKey(t)) && (!type || t.type === type),
          )
          .slice(0, 20);
      });
  }

  /** Everything watched, for the Watchlist page: read from the log's rows, named as the library is. */
  const history = $derived.by(() => {
    void version;
    if (route.page !== 'watchlist' || !log) return [];
    return watchedHistory(log.rows(), session.displayTitles());
  });
  const seenOfSeries = $derived.by(() => {
    void version;
    return route.page === 'watchlist' && log ? seenEpisodes(log.rows()) : new Map();
  });

  function caption(entry: ContinueEntry): string | undefined {
    if (entry.episode) return `S${entry.episode.season} · E${entry.episode.episode}`;
    return entry.title.year ? String(entry.title.year) : undefined;
  }
</script>

{#if link && log === undefined && !stagedHome}
  <Loading label="Loading your library" page />
{:else if link && (log === null || (route.page !== 'title' && !library && !stagedHome))}
  <p class="note">
    Couldn’t open your library. Check that this device is on your network. If your TV reset its
    library key, unlink in
    <a href="/settings">Settings</a> and pair again.
  </p>
{:else if route.page !== 'library' && !tmdbKey}
  <p class="note">
    {#if link}
      This page needs your TMDB key: your TV shares it, or add it in <a href="/settings">Settings</a
      >.
    {:else}
      Title pages need a TMDB key, which arrives with a paired Apple TV.
      <a href="/settings">Pair one</a> to see them.
    {/if}
  </p>
{:else if page && !DetailScreen.current}
  <ScreenLoading screen={DetailScreen} />
{:else if page}
  <!-- The player opens over this page rather than as a route of its own, so the page stays mounted
       and in front of the viewer as far as it knows: without `!playing` its trailer plays on under
       the film. Same reason the billboard below takes it. -->
  <DetailScreen.current
    {reel}
    {routes}
    {atlas}
    active={active && !playing}
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
    seed={pageSeed}
    still={pageStill}
    {busy}
    {failure}
    {notice}
    onwatchlist={(title, on) => act(title, on ? addToWatchlist : removeFromLibrary)}
    onseen={setSeen}
    onseason={markSeasonSeen}
    onreact={(title, reaction) => act(title, (row, at) => react(row, reaction, at))}
    onplay={play}
    onplayhere={playHere}
    {remux}
    away={remuxAway && !!scout && !!tmdbKey}
    blocked={remuxBlocked}
    ceiling={detailPrefs.ceiling}
    onepisode={markEpisodeSeen}
    shown={relatedShown}
  />
{:else if route.page === 'person' && !PersonScreen.current}
  <ScreenLoading screen={PersonScreen} />
{:else if route.page === 'search' && !SearchScreen.current}
  <ScreenLoading screen={SearchScreen} />
{:else if route.page === 'person'}
  <PersonScreen.current id={route.id} {tmdbKey} {active} />
{:else if route.page === 'service' && !ServiceScreen.current}
  <ScreenLoading screen={ServiceScreen} />
{:else if route.page === 'service'}
  <ServiceScreen.current
    id={route.id}
    country={route.country}
    {tmdbKey}
    {atlas}
    {atlasReady}
    minYear={prefs.minReleaseYear}
    excludedLanguages={prefs.excludedLanguages}
    {reel}
    {routes}
    shown={browseShown}
    {active}
  />
{:else if route.page === 'search'}
  <SearchScreen.current
    {query}
    {explore}
    {tmdbKey}
    {atlas}
    {prefs}
    shown={browseShown}
    seeds={[...seeds.watched, ...seeds.watchlisted]}
    owned={seeds.owned}
    {active}
  />
{:else if route.page === 'people' && !PeopleScreen.current}
  <ScreenLoading screen={PeopleScreen} />
{:else if route.page === 'people'}
  <PeopleScreen.current view={people} {tmdbKey} {atlas} {atlasReady} />
{:else if route.page === 'downloads'}
  {#if !library}
    <p class="note">
      Downloads live in your library, which this browser can’t keep. <a href="/settings"
        >Link a TV</a
      > to keep them there.
    </p>
  {:else if !DownloadsScreen.current}
    <ScreenLoading screen={DownloadsScreen} />
  {:else}
    <DownloadsScreen.current {active} />
  {/if}
{:else if route.page === 'watchlist'}
  {#if !library}
    <p class="note">
      Your watchlist lives in your library, which this browser can’t keep. <a href="/settings"
        >Link a TV</a
      > to keep it there.
    </p>
  {:else if !shelvesReady}
    <div data-route-loading><Loading label="Loading your watchlist" page /></div>
  {:else if !WatchlistScreen.current}
    <ScreenLoading screen={WatchlistScreen} />
  {:else}
    {@const slides = watchlistSlides(library, seenOfSeries)}
    {#if tmdbKey && slides.length}
      <Billboard
        active={active && !playing}
        titles={slides}
        {tmdbKey}
        {reel}
        {routes}
        onplay={playHere && ((title) => playHere(title))}
        rowOf={log ? rowOf : undefined}
        onwatchlist={(title, on) => fromSlide(act(title, on ? addToWatchlist : removeFromLibrary))}
        onseen={(title, on) => fromSlide(setSeen(title, on))}
        watchlistPage
      />
    {/if}
    <WatchlistScreen.current
      resume={continueEntries}
      saved={watchlist(library)}
      {history}
      year={watchedYear}
      onyear={(year) => navigate(watchlistHref(year))}
      shapes={session.shapes}
      seen={seenOfSeries}
      {failure}
      ondismiss={(title) => void dismiss(title)}
      onremove={(title) => void act(title, removeFromLibrary)}
      onseen={(title, seen) => void setSeen(title, seen)}
    />
  {/if}
{:else}
  {@const resume = continueEntries.filter((e) => !facet || e.title.type === facet)}
  {@const saved = (stagedHome ? stagedWatchlist : library ? watchlist(library) : []).filter(
    (t) => !facet || t.type === facet,
  )}
  <!-- The billboard reaches the top of the window and runs behind the navigation bar. -->
  {#if tmdbKey}
    <Billboard
      active={active && !playing}
      titles={featured.filter(featuredShown)}
      bind:showing={slideShown}
      {tmdbKey}
      {reel}
      {routes}
      onready={() => (heroReady = true)}
      onretained={(title, detail) =>
        void enrichPersonalBackdrop(libraryIdentity, facet, fresh, title, detail)}
      onplay={playHere && ((title) => playHere(title))}
      rowOf={log ? rowOf : undefined}
      onwatchlist={(title, on) => fromSlide(act(title, on ? addToWatchlist : removeFromLibrary))}
      onseen={(title, on) => fromSlide(setSeen(title, on))}
    />
  {/if}
  {#if !shelvesReady && (!shelfOrderReady || facet)}
    <div data-route-loading><Loading label="Loading your shelves" /></div>
  {:else}
    {#if shelvesReady && resume.length}
      <WindowedPosterRow
        heading="Continue Watching"
        items={resume}
        itemKey={(entry) => `${entry.title.type}:${entry.title.id}`}
        itemHref={(entry) => titleHref(entry.title)}
        itemLabel={(entry) => entry.title.title}
        onintent={() => void shelfNaming?.admit('continue')}
      >
        {#snippet children(entry)}
          <PosterCard
            title={entry.title}
            caption={caption(entry)}
            progress={entry.fraction}
            live={liveClock(entry)}
            href={titleHref(entry.title)}
            continueWatching
          />
        {/snippet}
      </WindowedPosterRow>
    {:else if !shelvesReady && !facet && shelfPlan?.continue}
      <PendingPosterRow heading="Continue Watching" />
    {/if}
    {#if !facet && downloading.length && shelvesReady}
      <WindowedPosterRow
        heading="Downloading"
        aside={{ label: 'All downloads', href: '/downloads' }}
        items={downloading}
        itemKey={(download) => download.name}
        itemHref={(download) =>
          titleHref({
            type: download.title.mediaType,
            id: download.title.mediaId,
            title: download.title.title || download.release.label,
          })}
        itemLabel={(download) => download.title.title || download.release.label}
        landscape
      >
        {#snippet children(download)}
          {@const answer = downloads.answers.get(download.name)}
          {@const title = {
            type: download.title.mediaType,
            id: download.title.mediaId,
            title: download.title.title || download.release.label,
            posterPath: download.title.posterPath,
          }}
          <DownloadPosterCard
            {download}
            {title}
            badge={answer?.state === 'preparing' && answer.progress
              ? `${Math.floor(Math.min(answer.progress, 1) * 100)}%`
              : undefined}
            caption={headline(downloads.status(download), answer)}
            progress={answer?.state === 'preparing' ? answer.progress : undefined}
            href={titleHref(title)}
          />
        {/snippet}
      </WindowedPosterRow>
    {/if}
    {#if shelvesReady && saved.length}
      <WindowedPosterRow
        heading="Watchlist"
        items={saved}
        itemKey={(title) => `${title.type}:${title.id}`}
        itemHref={titleHref}
        itemLabel={(title) => title.title}
        onintent={() => void shelfNaming?.admit('watchlist')}
      >
        {#snippet children(title)}
          <PosterCard
            {title}
            caption={title.year ? String(title.year) : undefined}
            href={titleHref(title)}
          />
        {/snippet}
      </WindowedPosterRow>
    {:else if !shelvesReady && !facet && shelfPlan?.watchlist}
      <PendingPosterRow heading="Watchlist" />
    {/if}
    {#if !facet}
      <ServicesRow {services} pending={naming ? servicePicks.length : 0} onintent={primeService} />
    {/if}
    <Browse {rows} shown={browseShown} />
  {/if}
{/if}

{#if playing && scout && remux !== null && !PlayerScreen.current}
  <!-- Over the page as the player would be, which it has made inactive: without this a player whose chunk couldn't
       be had left Play doing nothing, and the page's trailer stopped. -->
  <div class="player-screen" role="dialog" aria-modal="true" aria-label={playing.title.title}>
    <ScreenLoading screen={PlayerScreen} />
    <button class="close" onclick={() => (playing = null)}>Close</button>
  </div>
{:else if playing && scout && remux !== null && PlayerScreen.current}
  {@const target = playing}
  {@const after = following}
  <!-- A session names one source: a shared scout goes with the shared subtitles, a library's with its own. -->
  {@const guestSource = !!sharedInstallOf(scout.install)}
  {#key `${titleKey(target.title)}:${target.season}:${target.episode}`}
    <PlayerScreen.current
      title={target.title}
      season={target.season}
      episode={target.episode}
      filename={target.filename}
      {tmdbKey}
      {scout}
      {remux}
      subtitles={installsOf(plugins, routes, 'subs').filter(
        (install) => !!sharedInstallOf(install) === guestSource,
      )}
      audioLanguage={playbackPrefs.audioLanguage}
      subtitleLanguage={playbackPrefs.subtitleLanguage}
      shownSubtitleLanguages={playbackPrefs.shownSubtitleLanguages}
      autoSkip={playbackPrefs.autoSkipSegments}
      resume={resumePoint(target)}
      next={after ? `S${after.season} · E${after.episode}` : undefined}
      nextEpisode={after ? { season: after.season, episode: after.episode } : undefined}
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

  .player-screen {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 8px;
    padding: 0 var(--gutter);
    background: #000;
    color: #fff;
    text-align: center;
  }

  .close {
    min-height: 44px;
    padding: 8px 16px;
    border: 1px solid rgb(255 255 255 / 0.3);
    border-radius: 999px;
    background: none;
    color: inherit;
    cursor: pointer;
  }
</style>
