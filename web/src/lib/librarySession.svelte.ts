import { LIVE_PULL_MS } from './livePosition';
import { browserClock } from './clock';
import { LibraryLog } from './log';
import { dueAtLaunch, markReconciled, reconcile, recoveryContext } from './recovery';
import { deliverSimkl } from './simklDelivery';
import { driveDownloads } from './downloadDriver';
import { downloads } from './downloadQueue.svelte';
import type { DownloadTitle } from './downloadRows';
import { fetchImdbId } from './tmdb';
import { fetchSourceList, scoutTicket, type SourceAnswer, type TitleSource } from './titleSources';
import { switchLibraryToV4, upgradeLibrary } from './libraryUpgrade';
import {
  applyLog,
  ContinueProjector,
  emptyLibrary,
  nameContinueCandidates,
  withDisplay,
  type ContinueCandidate,
  type ContinueEntry,
  type Library,
  type Shape,
  type Title,
} from './library';
import type { Row } from './wire';
import { forgetLibraryCredential } from './relayFetch';
import { fetchRoutes, type Routes } from './routes';
import { SessionServices } from './sessionServices.svelte';

/** Cached pages share one log and revision, so a detail action updates the retained Home immediately. */
export class LibrarySession {
  displays = $state<Title[]>([]);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Consumers assign complete shape snapshots to state; they never mutate this map in place.
  shapes = $state(new Map<string, Shape>());
  revision = $state(0);
  settingsRevision = $state(0);
  /** Something in the library is playing somewhere (`livePosition`): pull faster, so a pause shows soon. */
  live = false;
  log = $state<LibraryLog | null | undefined>(undefined);
  /** A passing message about the library ("Library updated to v4"), shown for a few seconds (`notify`). */
  toast = $state<string | null>(null);
  /** Undoes whatever the toast just reported — "Removed from watchlist" and "Removed from Continue Watching"
      only, the two the poster menu can take back. Cleared with the toast. */
  undo = $state<{ label: string; run: () => void } | null>(null);
  /** What keeps the library from being written, while it does (`libraryAlert`). */
  alert = $state<string | null>(null);
  private toastTimer?: ReturnType<typeof setTimeout>;
  readonly opened: Promise<LibraryLog | null>;
  private refreshing?: Promise<void>;
  private readonly clock = browserClock();
  /** One immutable fold of the log for every revision, shared by all retained route trees. */
  private projection?: { revision: number; log: LibraryLog; rows: Row[]; library: Library };
  /** Policy decisions survive revisions; ContinueProjector invalidates only the series whose input changed. */
  private readonly continueProjector = new ContinueProjector();
  private continued?: {
    projection: Library;
    shapes: Map<string, Shape>;
    candidates: ContinueCandidate[];
  };
  private displayed?: {
    projection: Library;
    displays: Title[];
    shapes: Map<string, Shape>;
    library: Library;
  };
  private namedContinue?: {
    candidates: ContinueCandidate[];
    library: Library;
    entries: ContinueEntry[];
  };
  private readonly device = this.clock.device;
  /** The log's generation changes the last recovery reconcile followed (`reconcileRecovery`). */
  private recoveryGenerations = 0;
  /** Asked as the session starts, beside the library: discovery needs them, and they don't need the library. */
  private early?: Promise<Routes> = fetchRoutes();
  /** Where the library's services answer, found once for every page (`sessionServices.svelte.ts`). */
  readonly services = new SessionServices(
    () => this.routes(),
    () => this.changed(true),
  );
  /**
   * A session with no key never opens a library: `log` is null from the outset and stays there. That is the
   * guest — someone browsing without having paired — and it is the whole of the difference, because
   * `routes()` is keyless and still answers, which is what service discovery needs.
   */
  constructor(
    private readonly key: string | null,
    /** `key` is this browser's own library (`LibraryLog.openLocal`), kept here with no TV behind it. */
    readonly local = false,
  ) {
    this.opened = this.refresh().then(() => this.log ?? null);
  }

  /** den-edge's routes: the ones asked at the start the first time, a fresh ask after that. */
  routes(): Promise<Routes> {
    const early = this.early;
    this.early = undefined;
    return early ?? fetchRoutes();
  }

  /** One refresh owner for every route, including Settings. Failed opens are retryable. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        // No key, no library — and nothing to retry, unlike an open that failed.
        if (this.key === null) {
          // A browser that just gave up its key is a visitor again, and must stop claiming a membership.
          forgetLibraryCredential();
          this.log = null;
          return;
        }
        if (this.local) {
          // Its own library is still a visitor's: it proves no membership of anything on den-edge.
          forgetLibraryCredential();
          if (!this.log) {
            this.log = await LibraryLog.openLocal(this.key);
            if (this.log) this.changed(true);
          }
          if (this.log && (await upgradeLibrary(this.log, true))) this.changed(true);
          return;
        }
        if (!this.log) {
          this.log = await LibraryLog.open(this.key);
          if (this.log) this.attachDownloads(this.log);
          if (this.log) this.changed(true);
          // The copy kept from the last visit shows at once; what changed since follows it.
          if (!this.log?.fromCache) return;
        }
        const settings = () =>
          JSON.stringify(['keys', 'plugins', 'prefs'].map((name) => this.log?.settings(name)));
        const before = settings();
        if (await this.log.refresh()) this.changed(before !== settings());
        if (await upgradeLibrary(this.log, false)) this.changed(true);
        if (await switchLibraryToV4(this.log)) {
          this.changed(true);
          this.notify('Library updated to v4');
        }
        if (await this.log.compact()) this.changed(true);
        if (
          this.log.wireMinimum >= 3 &&
          !this.log.readOnly &&
          (await deliverSimkl(this.log, this.device))
        )
          this.changed(true);
        await this.reconcileRecovery(this.log, this.key);
        if (this.log.wireMinimum >= 4 && !this.log.readOnly) {
          this.attachDownloads(this.log);
          // Only a page someone is looking at polls den-scout and drives the queue; a hidden one lets its lease lapse.
          // The lease holds only while each pass comes within 120 s of the last: `start` refreshes a visible page
          // every 30 s (5 s while something plays), so a renewal due at 60 s always lands. A tick slower than 120 s
          // would make den-core stop the hold, and the page would wait ten minutes to take it back.
          const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
          if (visible && (await driveDownloads(this.log, downloads, this.device))) this.changed();
        }
      } catch (error) {
        // Keep an existing log and its journal intact; an initial failure can open again next tick.
        console.warn('den: the library could not be refreshed', error);
        if (!this.log) this.log = null;
      } finally {
        this.alert = this.log ? libraryAlert(this.log) : null;
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /**
   * den-edge's recovery entries made to match the library (recovery-code §7): at launch at most once a day, and after
   * each generation change once the write-back is done. Settings reconciles again when its screen opens.
   */
  private async reconcileRecovery(log: LibraryLog, key: string): Promise<void> {
    if (log.moved) return;
    const generations = log.generationChanges;
    const ctx = await recoveryContext(key, log, browserClock());
    if (generations === this.recoveryGenerations && !dueAtLaunch(ctx.libraryId)) return;
    const status = await reconcile(ctx);
    // A reconcile that did nothing (den-edge or the log not read to its head) leaves both triggers armed.
    if (!status) return;
    this.recoveryGenerations = generations;
    markReconciled(ctx.libraryId);
    for (const notice of status.notices) this.notify(notice);
  }

  start(onMoved: () => void): () => void {
    // Nothing to poll for, and no library that could move out from under this browser.
    if (this.key === null || this.local) return () => undefined;
    let disposed = false;
    const refresh = async () => {
      if (document.hidden || disposed) return;
      await this.refresh();
      if (!disposed && this.log?.moved) onMoved();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(() => void tick(), this.live ? LIVE_PULL_MS : 30_000);
    };
    void tick();
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }
  changed(settings = false) {
    this.revision++;
    if (settings) this.settingsRevision++;
    downloads.touch();
  }

  /**
   * Rows and their policy fold at the current log revision. A page, its naming pass, and retained sibling pages
   * all ask for the same snapshot; none should replay every synchronous den-core operation independently.
   */
  libraryProjection(): { rows: Row[]; library: Library } | null {
    const revision = this.revision;
    const log = this.log;
    if (!log) return null;
    if (!this.projection || this.projection.revision !== revision || this.projection.log !== log) {
      const rows = log.rows();
      this.projection = { revision, log, rows, library: applyLog(emptyLibrary(), rows) };
    }
    return this.projection;
  }

  /** The current projection with late display metadata overlaid, shared while those exact inputs are current. */
  displayedLibrary(projection: Library): Library {
    const displays = this.displays;
    const shapes = this.shapes;
    if (
      !this.displayed ||
      this.displayed.projection !== projection ||
      this.displayed.displays !== displays ||
      this.displayed.shapes !== shapes
    ) {
      this.displayed = {
        projection,
        displays,
        shapes,
        library: { ...withDisplay(projection, displays), shapes },
      };
    }
    return this.displayed.library;
  }

  /** Continue Watching from the same shared projection, recomputing only changed per-series policy inputs. */
  continueWatching(projection: Library, displayed: Library): ContinueEntry[] {
    const shapes = this.shapes;
    if (
      !this.continued ||
      this.continued.projection !== projection ||
      this.continued.shapes !== shapes
    ) {
      this.continued = {
        projection,
        shapes,
        candidates: this.continueProjector.project({ ...projection, shapes }),
      };
    }
    const candidates = this.continued.candidates;
    if (
      !this.namedContinue ||
      this.namedContinue.candidates !== candidates ||
      this.namedContinue.library !== displayed
    ) {
      this.namedContinue = {
        candidates,
        library: displayed,
        entries: nameContinueCandidates(candidates, displayed),
      };
    }
    return this.namedContinue.entries;
  }

  /** The shared download queue reads and writes this library's rows (den-spec library-v4 §17). */
  private attachDownloads(log: LibraryLog): void {
    downloads.attach(
      log,
      this.clock,
      (url) => this.ticket(url),
      (title) => this.resolveDownload(title),
    );
  }

  /** A play ticket another device wrote, as this page asks it (`scoutTicket`); null where it can't reach it. */
  private ticket(url: string): string | null {
    if (url.startsWith('/scout/')) return url;
    const scout = this.services.scout;
    return scout ? scoutTicket(url, scout, this.services.routes) : null;
  }

  /** A download's content resolved again at scout, for a fallback or a ticket this page can't use. */
  private async resolveDownload(
    title: DownloadTitle,
  ): Promise<{ sources: TitleSource[] | null; answer?: SourceAnswer }> {
    const scout = this.services.scout;
    if (!scout) return { sources: null };
    const imdb =
      title.imdbId ??
      (this.services.tmdbKey
        ? await fetchImdbId({ type: title.mediaType, id: title.mediaId }, this.services.tmdbKey)
        : undefined);
    if (!imdb) return { sources: null };
    return fetchSourceList(scout, imdb, this.services.routes, title.season, title.episode);
  }

  /**
   * A passing message. Cleared after `TOAST_MS` by default; `holdMs` overrides that, and `Infinity` holds it up
   * until the next `notify` (or page navigation resets it) — for a toast that updates in place while something is
   * still pending, such as "Play on TV"'s (`playOnTv.svelte.ts`). `undo`, where the action it reports can be
   * taken back, is offered until the toast itself clears.
   */
  notify(
    message: string,
    {
      holdMs = TOAST_MS,
      undo = null,
    }: { holdMs?: number; undo?: { label: string; run: () => void } | null } = {},
  ) {
    this.toast = message;
    this.undo = undo;
    clearTimeout(this.toastTimer);
    if (Number.isFinite(holdMs))
      this.toastTimer = setTimeout(() => {
        this.toast = null;
        this.undo = null;
      }, holdMs);
  }
}

const TOAST_MS = 6000;

/** What stops this browser writing the library, said the way the spec words it (library v4 §4, §10). */
export function libraryAlert(log: LibraryLog): string | null {
  if (log.upgradeRequired !== null) return 'Library update required';
  if (log.predatesV3) return 'Library backup predates v3';
  if (log.switchFailure) return `Library update failed: ${log.switchFailure}`;
  if (log.compactionRefused && log.unreadable.size)
    return 'Delivery paused: library rows can’t be read';
  return null;
}
