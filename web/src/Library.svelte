<script lang="ts">
  import Loading from './components/Loading.svelte';
  import { untrack } from 'svelte';
  import Billboard from './components/Billboard.svelte';
  import Browse from './components/Browse.svelte';
  import PosterCard from './components/PosterCard.svelte';
  import PosterRow from './components/PosterRow.svelte';
  import WatchlistPage from './components/WatchlistPage.svelte';
  import { seenEpisodes, watchedHistory } from './lib/history';
  import {
    DetailScreen,
    PersonScreen,
    PlayerScreen,
    preloadScreens,
    SearchScreen,
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
    unwatch,
    unwatchSeries,
    updateEpisodeProgress,
    updateProgress,
    WATCHED,
  } from './lib/actions';
  import { browseRows, homeRows, interleave, personalRows, tmdbPages } from './lib/catalog';
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
  import type { LibrarySession } from './lib/librarySession.svelte';
  import { nameLibraryTitles, shelfTitleRefs, personalSeedRows } from './lib/libraryNaming';
  import { recordTrackerEvent } from './lib/trackerEvents';
  import { ensureSyncPolicy } from './lib/syncLoader';
  import { ADDRESSES, ahead, healed, readPrivateAddresses } from './lib/privateAddresses';
  import { availability } from './lib/availability.svelte';
  import { isHidden, readApiKey, readPlugins, readPrefs, readDetailPrefs } from './lib/prefs';
  import { readSyncedPrefs } from './settings/values';
  import { hlsURL, nativeHls, trailerURLs } from './lib/reel';
  import { titleHref, type Route } from './lib/route';
  import { warmOnIntent } from './lib/warmOnIntent';
  import { discoverServices } from './lib/discoverServices';
  import type { Routes } from './lib/routes';
  import { installsOf, type Addon } from './lib/scout';
  import { fetchDetails, fetchTitle, tmdbKeyOf } from './lib/tmdb';
  import { nameSlides, recommend, recommendBody } from './lib/recommend';
  import { atlasRows } from './lib/atlasRows';
  import type { EpisodeRow, Row, SettingsRow, Stamp, TitleRow } from './lib/wire';

  let {
    link,
    route,
    active,
    session,
    query = '',
  }: {
    /** Null for a guest: someone browsing who has not paired, and so has no library behind them. */
    link: Link | null;
    route: Route;
    active: boolean;
    session: LibrarySession;
    query?: string;
  } = $props();

  /** TMDB lookups at once while naming the library: quick for a big watchlist, and polite to TMDB. */
  const LOOKUPS = 6;
  /** Where this browser keeps what discovery found (`LibraryLog.keep`). */
  const SERVICES = 'services.v1';
  type Services = {
    routes: Routes;
    scout: Addon | null;
    atlas: string | null;
    reel: string | null;
    remux: string | null;
  };
  const warnKeep = (error: unknown) => console.warn('den: Home could not be kept', error);
  const SAVE_FAILED = 'Couldn’t save that. Check that this device is on your network.';

  /** The TMDB key the library shares (`set:keys`). */
  let tmdbKey = $state('');
  /** Keep the initial shelves together; naming must not insert rows above an already painted row. */
  let shelvesReady = $state(false);
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
  /** This visit's discovery answered, and no route reaches den-remux from here: away from home and off the tailnet. */
  let remuxAway = $state(false);

  /**
   * Keep where a service actually answered, when the library doesn't already say so.
   *
   * den-edge's public name serves a table naming nothing private, so a viewer on Tailscale is told
   * nothing about den-remux even though it is a hostname away. The library is sealed and can hold
   * what the table won't publish — but only what a device has reached for itself, and only from a
   * face that could see it.
   *
   * Quiet on purpose. Nobody asked for this write, and a household that cannot reach its own library
   * has a larger problem than an address the next visit will discover again.
   */
  async function rememberAddress(service: string, reached: string | null) {
    const opened = log;
    if (!opened) return;
    const change = healed(readPrivateAddresses(opened.settings(ADDRESSES)), service, reached);
    if (!change) return;
    try {
      await ensureSyncPolicy();
      const base = opened.settings(ADDRESSES) ?? {
        kind: 'set' as const,
        schema: 2,
        name: ADDRESSES,
        values: {},
      };
      const at = clock.issue();
      const values = { ...base.values };
      for (const [key, value] of Object.entries(change)) values[key] = { value, at };
      if (await opened.write({ ...base, values })) session.changed(true);
    } catch {
      // Rediscovered next visit; not worth a word to someone who asked for none of it.
    }
  }

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
    // `undefined` is a library still opening. `null` is a guest — no library, and still every reason to run
    // the discovery below: atlas gives them rows and reel gives them trailers, both on this origin.
    if (opened === undefined) return;
    let disposed = false;
    let stopDiscovery: (() => void) | undefined;
    // Only the shared settings revision and opened log trigger reconfiguration.
    // Service state below is an output, not a dependency of this effect.
    untrack(() => {
      // A device with no key of its own borrows den-edge's (`tmdbKeyOf`), so a guest — and a household that
      // never set one — sees titles rather than an empty page. What Settings reports as set stays the
      // library's own key: borrowing one is not the same as having one.
      tmdbKey = tmdbKeyOf(opened?.settings('keys'));
      // Naming the library is still only the paired case: it reads the log itself.
      if (tmdbKey && opened) {
        const key = tmdbKey;
        const raw = applyLog(emptyLibrary(), opened.rows());
        const priority = shelfTitleRefs(raw, opened.rows());
        const reserved = new Set(priority.map(titleKey));
        void nameLibraryTitles(session, priority, key).then(() => {
          if (disposed) return;
          shelvesReady = true;
          // Watched history enriches taste in the background; it cannot change the initial shelf order.
          void nameLibraryTitles(
            session,
            untitled(raw).filter((ref) => !reserved.has(titleKey(ref))),
            key,
          ).then(() => {
            if (!disposed) libraryNamed = true;
          });
        });
      } else shelvesReady = true;
      plugins = opened ? readPlugins(opened.settings('plugins')) : [];
      const [key, installed] = [tmdbKey, plugins];
      // Where the last visit found the addons, used until this visit's discovery answers. A guest keeps
      // nothing between visits — what is kept lives in the library — so there is nothing to restore.
      let live = false;
      if (opened)
        void opened.kept<Services>(SERVICES).then((saved) => {
          if (disposed || live || !saved) return;
          ({ routes, scout, atlas, reel, remux } = saved);
          availability.connect(saved.scout, key);
        });
      void (async () => {
        const foundRoutes = await session.routes();
        if (disposed) return;
        live = true;
        routes = foundRoutes;
        // The household's own tailnet address for den-remux, tried ahead of the table's entries: on
        // the public name the table names none at all, and this is the only thing that reaches it.
        const kept = readPrivateAddresses(opened?.settings(ADDRESSES));
        const forDiscovery = { ...foundRoutes, remux: ahead(kept.remux, foundRoutes.remux) };
        stopDiscovery = discoverServices(installed, forDiscovery, {
          // A guest is handed neither publisher, so those probes are never issued and the playback
          // services cannot be discovered at all. Structural, rather than a callback someone has to
          // remember to leave out.
          ...(opened
            ? {
                scout: (found: Addon | null) => {
                  scout = found;
                  availability.connect(found, key);
                },
                remux: (found: string | null) => {
                  remux = found;
                  remuxAway = found === null;
                  // Where it answered, kept for the visit that will be shown no private address.
                  void rememberAddress('remux', found);
                },
              }
            : {}),
          atlas: (found) => {
            atlas = found?.base ?? null;
          },
          reel: (found) => {
            reel = found?.base ?? null;
          },
        });
      })();
    });
    return () => {
      disposed = true;
      stopDiscovery?.();
    };
  });

  // What discovery found, kept for the next visit once it has settled for a moment.
  $effect(() => {
    const opened = log;
    const found: Services = $state.snapshot({ routes, scout, atlas, reel, remux });
    if (!opened || !Object.keys(found.routes).length) return;
    const timer = setTimeout(() => void opened.keep(SERVICES, found).catch(warnKeep), 1000);
    return () => clearTimeout(timer);
  });

  /** The log's rows applied, only when the log changes: names arrive far more often and are laid over it below. */
  const applied = $derived.by(() => {
    void version;
    return log ? applyLog(emptyLibrary(), log.rows()) : null;
  });
  const library = $derived(
    applied && { ...withDisplay(applied, session.displays), shapes: session.shapes },
  );

  /** The title whose page is open, if one is. */
  const page = $derived(route.page === 'title' ? { type: route.type, id: route.id } : null);

  // A screen Home doesn't draw loads when this page is it (`screens.svelte.ts`).
  $effect(() => {
    if (page) void DetailScreen.load();
    else if (route.page === 'person') void PersonScreen.load();
    else if (route.page === 'search') void SearchScreen.load();
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
    if (!session.displays.some((d) => d.type === title.type && d.id === title.id))
      session.displays = [...session.displays, title];
  }

  /** Write one row and re-derive what shows it. */
  async function save(row: Row, journal = false) {
    if (!log) return;
    busy = true;
    failure = null;
    try {
      const saved =
        journal && row.kind === 'set' ? await log.writeAction(row) : await log.write(row);
      if (log.moved) {
        if (link) links.forgetMoved(link);
        return;
      }
      if (!saved) failure = SAVE_FAILED;
      else if (log.pendingActions > 0)
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

  /**
   * Off Continue Watching. Not an action the trackers hear about — nothing about what was watched changed, and the
   * TV's own dismissal sends nothing either — so the row itself is written rather than a tracker event, which the
   * sync policy doesn't capture for this change and `act` would then drop.
   */
  async function dismiss(title: Title) {
    if (!log) return;
    try {
      // Stamping runs through the sync policy, as for every other action: without it loaded the dismissal throws.
      await ensureSyncPolicy();
      remember(title);
      const before = log.title(title) ?? blankTitle(title, Date.now());
      clock.see(log.newestStamp());
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
        const shape =
          session.shapes.get(titleKey(title)) ?? (await fetchDetails(title, tmdbKey))?.shape;
        if (!shape) {
          failure = 'Couldn’t load the episodes. Nothing was marked Seen.';
          return;
        }
        const journals: SettingsRow[] = [];
        clock.see(log.newestStamp());
        for (const [season, count] of [...shape.counts].sort((a, b) => a[0] - b[0])) {
          if (season <= 0) continue;
          for (let episode = 1; episode <= count; episode++) {
            if (!isAired({ season, episode }, shape.lastAired)) continue;
            const before =
              log.episode(title, season, episode) ?? blankEpisode(title, season, episode);
            const at = clock.issue();
            const event = recordTrackerEvent(before, markEpisode(before, seen, at), at);
            if (event) journals.push(event);
          }
        }
        const before = log.title(title) ?? blankTitle(title, Date.now());
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
          if (!(await log.writeActions(journals))) failure = SAVE_FAILED;
          else if (log.pendingActions > 0)
            notice =
              'Saved on this device. Waiting to sync—keep this browser’s data until it reconnects.';
          session.changed();
        } catch {
          failure = SAVE_FAILED;
        } finally {
          busy = false;
        }
        return;
      }
      await act(title, seen ? markWatched : unwatch);
    } catch {
      failure = SAVE_FAILED;
      return false;
    }
  }

  /**
   * Start the title on the linked TV, as the TV's own Play would — it picks the source.
   *
   * Undefined for a guest, and that is the enforcement: `sendToTV` needs the link's own keys, so with no
   * link there is nothing to pass and this cannot be constructed at all. A missing callback, which the
   * type checker insists on, rather than a callback that declines at runtime.
   */
  const play = $derived(
    link
      ? async (title: Title, season?: number, episode?: number) => {
          busy = true;
          failure = null;
          notice = null;
          const sent = await sendToTV(link, {
            type: 'play',
            tmdbId: title.id,
            mediaType: title.type,
            title: title.title,
            season,
            episode,
          });
          busy = false;
          if (sent)
            notice = `Sent to ${link.name ?? 'your TV'}. It starts when the TV is on and Den is open.`;
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
      ? (title: Title, season?: number, episode?: number, filename?: string) => {
          if (title.type === 'tv' && (season === undefined || episode === undefined)) {
            const up =
              library &&
              continueWatching(library).find((e) => titleKey(e.title) === titleKey(title))?.episode;
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
    if (!log) return;
    try {
      await ensureSyncPolicy();
      const { title, season, episode } = target;
      remember(title);
      if (season !== undefined && episode !== undefined) {
        const row = log.episode(title, season, episode) ?? blankEpisode(title, season, episode);
        await save(updateEpisodeProgress(row, fraction, seconds, clock.issue()));
      } else {
        await save(
          updateProgress(
            log.title(title) ?? blankTitle(title, Date.now()),
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
   * Fire and forget. It is a warm-up; reel caches the answer either way, and `trailerURLs` reports a
   * failure as an empty list rather than throwing.
   */
  function warmTrailer(title: { type: Title['type']; id: number; imdbId?: string }) {
    // The page itself, before its trailer. `preloadScreens` fetches this chunk once Home is idle, so
    // it is usually resident already — but a press within the first second of a visit landed on the
    // route-level spinner while it downloaded. Idempotent: a second call joins the first.
    void DetailScreen.load();
    // No imdb id needed any more: reel takes the tmdb id every title has, and is told the imdb one when
    // we happen to hold it. A title whose imdb id was never fetched used to get no trailer at all.
    if (!reel) return;
    void trailerURLs(reel, title.type, { tmdb: title.id, imdb: title.imdbId }, routes, {
      prewarm: 'direct',
    }).then((found) => {
      // The master too, not just the resolve. reel answers it `private, max-age=300`, so this lands
      // in the browser's own cache and the page that is about to mount reads it from there — one
      // round trip and a googlevideo fetch taken off the critical path, spent during the ~150ms
      // between the press and the click.
      const master = found[0] && hlsURL(found[0]);
      if (master) void fetch(master).catch(() => undefined);
    });
    // hls.js is a dynamic import, so the first trailer of a session pays for fetching and parsing it
    // before it can play anything. Started here, it is usually resident by then.
    if (!nativeHls()) void import('hls.js').catch(() => undefined);
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
    // The billboard, then anything named through the library. A browse row's titles are loaded
    // inside the row itself and are not reachable from here, so a press on one of those still opens
    // on the placeholder — worth doing, but not worth threading a callback through every card for.
    return featured.find(here) ?? session.displays.find(here);
  });

  /** The TV's hide rules, from the log's `set:prefs`. */
  const prefs = $derived.by(() => {
    void version;
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
      library?.records
        .filter((r) => !r.deleted && r.status === 'watched')
        .map((r) => titleKey(r.title)) ?? [],
    ),
  );
  const browseShown = (title: Title) =>
    shown(title) && !(prefs.hideWatched && watched.has(titleKey(title)));
  /** The billboard's own rule: everything the rows hide, except the missing poster it doesn't draw. */
  const featuredShown = (title: Title) =>
    !isHidden(title, prefs, { requirePoster: false }) &&
    !(prefs.hideWatched && watched.has(titleKey(title)));
  /**
   * Every title the library holds with how much it says about taste, straight from the log: what atlas ranks the
   * billboard against (`recommendBody`). Watched and part-watched titles are a verdict and count full; a watchlisted
   * one is an intention and counts for less; a reaction is the one thing said outright, so it counts for more than
   * either, and a dislike counts against. Ids and weights need no names, so nothing here waits for TMDB.
   */
  const weighted = $derived.by(() => {
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
  /**
   * Whether TMDB has named the whole library, watched history included: atlas is asked again once it has, since
   * it reads a title it doesn't hold by the name TMDB gives it.
   */
  let libraryNamed = $state(false);
  /** The browse screens' rows, headers now and posters as each nears the screen. */
  const pages = $derived(tmdbKey ? tmdbPages(tmdbKey) : null);
  /** The seeds of Home's personal rows: your two latest watched or liked titles, and two latest watchlisted, named. */
  const seeds = $derived.by(() => {
    void version;
    const titleRows = (log?.rows() ?? []).filter(
      (r): r is TitleRow => r.kind === 'rec' && !r.deleted.value,
    );
    const named = new Map(
      (library?.records ?? [])
        .filter((r) => r.title.title)
        .map((r) => [titleKey(r.title), r.title]),
    );
    const selected = personalSeedRows(titleRows);
    const namedSeeds = (refs: TitleRow[]) =>
      refs.flatMap((r) => named.get(titleKey(r.title)) ?? []);
    return {
      watched: namedSeeds(selected.watched),
      watchlisted: namedSeeds(selected.watchlisted),
      owned: new Set(titleRows.map((r) => titleKey(r.title))),
    };
  });
  const rows = $derived.by(() => {
    if (!pages) {
      // No TMDB key, so no TMDB rows — a guest, until the server-side key lands. atlas needs no key at all:
      // its rows carry their own titles, posters and ids, and the poster images come from a CDN that asks
      // for none. Without this a guest's home is simply blank, which is what it was.
      if (!atlas) return [];
      if (route.page === 'movies' || route.page === 'series')
        return atlasRows(atlas, route.page === 'movies' ? 'movie' : 'tv');
      return interleave([atlasRows(atlas, 'movie'), atlasRows(atlas, 'tv')]);
    }
    const minYear = prefs.minReleaseYear;
    if (route.page === 'movies' || route.page === 'series') {
      const type = route.page === 'movies' ? 'movie' : 'tv';
      const browse = browseRows(type, pages, { minYear, hiddenGenres: prefs.excludedGenres });
      // After Popular and the three genre rows, atlas's rows take turns with TMDB's categories and lead each
      // round, as the TV's index rows do: they say something a genre or a decade doesn't.
      const own = atlas ? atlasRows(atlas, type) : [];
      return [...browse.slice(0, 4), ...interleave([own, browse.slice(4)])];
    }
    // Home's spine and recipe rows (seven), then atlas's three strongest film rows before the categories.
    const home = homeRows(pages, { minYear });
    const plot = atlas ? atlasRows(atlas, 'movie').slice(0, 3) : [];
    return [...personalRows(pages, seeds), ...home.slice(0, 7), ...plot, ...home.slice(7)];
  });
  /** The screen's own facet: Movies shows your movies, Series your series, Home both. */
  const facet = $derived(route.page === 'movies' ? 'movie' : route.page === 'series' ? 'tv' : null);
  /**
   * What the billboard cycles. Not a row: a pool of its own, ranked by atlas (`POST /recommend`) — what is being
   * watched now, what is new or still to come, and what has just landed on this household's own services, weighted
   * towards the library's taste and away from anything it already holds.
   */
  let featured = $state<Title[]>([]);
  /** Which build of the billboard is the current one: a slower earlier one must not overwrite a later answer. */
  let billboardRun = 0;
  /** Where the billboard picked for a facet is kept for the next visit (`LibraryLog.keep`). */
  const keptBillboard = (type: 'movie' | 'tv' | null) => `billboard.v1.${type ?? 'all'}`;
  // A return visit shows the billboard it picked last time as soon as the library opens: this visit's build waits
  // for the library's profile, and the page shouldn't.
  $effect(() => {
    const opened = log;
    const name = keptBillboard(facet);
    if (!opened || !tmdbKey) return;
    void opened.kept<Title[]>(name).then((saved) => {
      if (saved?.length && !featured.length) featured = saved;
    });
  });
  // The screens Home doesn't draw load once its shelves are up, not while Home still needs the network.
  $effect(() => {
    if (shelvesReady) preloadScreens();
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
      route.page === 'watchlist'
    )
      return;
    const here = atlas;
    if (!tmdbKey) return;
    // atlas needs no profile read here first: it knows the library's titles by id, so it is asked as soon as the log
    // is open — and once more when TMDB has named the whole library, which is what atlas reads a title it has never
    // seen by.
    if (!here) {
      untrack(() => buildTrending(++billboardRun));
      return;
    }
    void libraryNamed;
    if (libraryOpen) untrack(() => buildRecommended(here));
  });

  /** Whether the log's rows have been read: once, rather than every time they change. */
  const libraryOpen = $derived(applied !== null);

  /**
   * The billboard as atlas ranks it (`lib/recommend.ts`). The TMDB lists go along as candidates — the rows below
   * fetch them anyway — and what atlas answers with is drawn: named from those lists where they hold it, and from
   * TMDB where only atlas's own lists did. An atlas that can't rank leaves what is trending (`buildTrending`).
   */
  function buildRecommended(here: string) {
    const table = rows;
    const type = facet;
    const key = tmdbKey;
    const run = ++billboardRun;
    const kept = keptBillboard(type);
    if (!table.length) return;
    const row = (id: string) =>
      table
        .find((r) => r.id === id)
        ?.load(1)
        .catch(() => []) ?? Promise.resolve([]);
    const feed = pages;
    const trendingTv = feed
      ? feed('/trending/tv/week', 'tv', {}, 1).catch(() => [])
      : Promise.resolve([]);
    void Promise.all([
      row('trending'),
      trendingTv,
      row('new-releases'),
      row('upcoming'),
      row('popular'),
    ])
      .then(async ([hotMovies, hotSeries, fresh, soon, popular]) => {
        const lists = [
          { titles: hotMovies, ranked: true },
          { titles: hotSeries, ranked: true },
          { titles: [...fresh, ...soon, ...popular], ranked: false },
        ];
        const named = new Map(
          (library?.records ?? [])
            .filter((r) => r.title.title)
            .map((r) => [titleKey(r.title), r.title] as const),
        );
        const ask = (offered: typeof lists) =>
          recommend(
            here,
            recommendBody({
              facet: type,
              prefs,
              library: weighted,
              named,
              owned: seeds.owned,
              lists: offered,
            }),
          );
        const first = await ask(lists);
        if (run !== billboardRun) return;
        if (!first) {
          buildTrending(run);
          return;
        }
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- A local lookup for this build; nothing renders from it.
        const known = new Map(
          lists.flatMap(({ titles }) => titles.map((t) => [titleKey(t), t] as const)),
        );
        const lookup = (ref: { type: 'movie' | 'tv'; id: number }) => fetchTitle(ref, key);
        const show = async (slides: typeof first.slides) => {
          const picked = await nameSlides(slides, known, lookup, LOOKUPS);
          if (run !== billboardRun || (!picked.length && featured.length)) return;
          const lead = featured[0];
          featured = keepLead(picked, lead && !seeds.owned.has(titleKey(lead)) ? lead : undefined);
          // What is kept is this pick in its own order. Keeping `featured` kept the lead too, so a title that led
          // once led every later visit, whatever atlas picked since.
          if (picked.length) void log?.keep(kept, picked).catch(warnKeep);
        };
        await show(first.slides);
        // What atlas has never seen it can't judge, and drops, however new it is: the likeliest of those are named
        // from TMDB (which this browser caches) and offered again, described.
        const described = await nameSlides(first.unjudged, known, lookup, LOOKUPS);
        if (!described.length || run !== billboardRun) return;
        for (const title of described) known.set(titleKey(title), title);
        const again = await ask([...lists, { titles: described, ranked: false }]);
        if (again && run === billboardRun) await show(again.slides);
      })
      .catch(() => undefined);
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

  /**
   * `picked`, with the title the billboard already shows kept in front, whether or not this pick chose it: a
   * rebuild — or this visit's pick replacing the last one's — must not swap the picture out from under someone
   * looking at it. The rest of the slides are this pick's, and the next visit leads with it.
   */
  function keepLead(picked: Title[], lead: Title | undefined): Title[] {
    if (!lead || !picked.length) return picked;
    return [lead, ...picked.filter((t) => titleKey(t) !== titleKey(lead))];
  }

  /** Everything watched, for the Watchlist page: read from the log's rows, named as the library is. */
  const history = $derived.by(() => {
    void version;
    if (route.page !== 'watchlist' || !log) return [];
    return watchedHistory(log.rows(), new Map(session.displays.map((t) => [titleKey(t), t])));
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

{#if link && log === undefined}
  <Loading label="Loading your library" page />
{:else if link && (log === null || !library)}
  <p class="note">
    Couldn’t open your library. Check that this device is on your network. If your TV reset its
    library key, unlink in
    <a href="#settings">Settings</a> and pair again.
  </p>
{:else if route.page !== 'library' && !tmdbKey}
  <p class="note">
    {#if link}
      This page needs your TMDB key: your TV shares it, or add it in <a href="#settings">Settings</a
      >.
    {:else}
      Title pages need a TMDB key, which arrives with a paired Apple TV.
      <a href="#settings">Pair one</a> to see them.
    {/if}
  </p>
{:else if page && !DetailScreen.current}
  <Loading label="Loading" page />
{:else if page}
  <!-- The player opens over this page rather than as a route of its own, so the page stays mounted
       and in front of the viewer as far as it knows: without `!playing` its trailer plays on under
       the film. Same reason the billboard below takes it. -->
  <DetailScreen.current
    {reel}
    {routes}
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
    {busy}
    {failure}
    {notice}
    onwatchlist={(title, on) => act(title, on ? addToWatchlist : removeFromLibrary)}
    onseen={setSeen}
    onreact={(title, reaction) => act(title, (row, at) => react(row, reaction, at))}
    onplay={play}
    onplayhere={playHere}
    away={remuxAway && !!scout && !!tmdbKey}
    onepisode={markEpisodeSeen}
    {shown}
  />
{:else if (route.page === 'person' && !PersonScreen.current) || (route.page === 'search' && !SearchScreen.current)}
  <Loading label="Loading" page />
{:else if route.page === 'person'}
  <PersonScreen.current id={route.id} {tmdbKey} {active} />
{:else if route.page === 'search'}
  <SearchScreen.current {query} {tmdbKey} {atlas} {prefs} />
{:else if route.page === 'watchlist'}
  {#if !library}
    <p class="note">
      Your watchlist lives in your library, which this browser can’t keep. <a href="/settings"
        >Link a TV</a
      > to keep it there.
    </p>
  {:else if !shelvesReady}
    <div data-route-loading><Loading label="Loading your watchlist" page /></div>
  {:else}
    <WatchlistPage
      resume={continueWatching(library)}
      saved={watchlist(library)}
      {history}
      shapes={session.shapes}
      seen={seenOfSeries}
      {failure}
      ondismiss={(title) => void dismiss(title)}
      onremove={(title) => void act(title, removeFromLibrary)}
      onseen={(title, seen) => void setSeen(title, seen)}
    />
  {/if}
{:else}
  {@const resume = library
    ? continueWatching(library).filter((e) => !facet || e.title.type === facet)
    : []}
  {@const saved = library ? watchlist(library).filter((t) => !facet || t.type === facet) : []}
  <!-- The billboard reaches the top of the window and runs behind the navigation bar. -->
  {#if tmdbKey}
    <Billboard
      active={active && !playing}
      titles={featured.filter(featuredShown)}
      {tmdbKey}
      {reel}
      {routes}
      onplay={playHere && ((title) => playHere(title))}
    />
  {/if}
  {#if !shelvesReady}
    <div data-route-loading><Loading label="Loading your shelves" /></div>
  {:else}
    {#if resume.length}
      <PosterRow heading="Continue Watching">
        {#each resume as entry (`${entry.title.type}:${entry.title.id}`)}
          <PosterCard
            title={entry.title}
            caption={caption(entry)}
            progress={entry.fraction}
            href={titleHref(entry.title)}
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
            href={titleHref(title)}
          />
        {/each}
      </PosterRow>
    {/if}
    <Browse {rows} shown={browseShown} />
  {/if}
{/if}

{#if playing && scout && remux !== null && PlayerScreen.current}
  {@const target = playing}
  {@const after = following}
  {#key `${titleKey(target.title)}:${target.season}:${target.episode}`}
    <PlayerScreen.current
      title={target.title}
      season={target.season}
      episode={target.episode}
      filename={target.filename}
      {tmdbKey}
      {scout}
      {remux}
      subtitles={installsOf(plugins, routes, 'subs')}
      audioLanguage={playbackPrefs.audioLanguage}
      subtitleLanguage={playbackPrefs.subtitleLanguage}
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
