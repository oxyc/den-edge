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
  applyLogInSlices,
  ContinueProjector,
  emptyLibrary,
  nameContinueCandidates,
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

/** Directly opened routes may never paint Home's billboard; background providers still start eventually. */
export const BACKGROUND_PROVIDER_FALLBACK_MS = 10_000;

/* eslint-disable svelte/prefer-svelte-reactivity -- Private projection indexes are deliberately non-reactive; their public snapshots and revision counters use $state. */
/** Cached pages share one log and revision, so a detail action updates the retained Home immediately. */
export class LibrarySession {
  displays = $state<Title[]>([]);
  shapes = $state(new Map<string, Shape>());
  /** Late TMDB display fields are not a library revision: consumers opt into this cheaper keyed stream. */
  displayRevision = $state(0);
  /** Episode layouts affect Continue policy, but not records, watched state, or recommendation ownership. */
  shapeRevision = $state(0);
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
  /** False once the component that owns this session has replaced it; abandoned startup work stops at a slice. */
  private active = true;
  /** One immutable fold of the log for every revision, shared by all retained route trees. */
  private projection?: { revision: number; log: LibraryLog; rows: Row[]; library: Library };
  /** Policy decisions survive revisions; ContinueProjector invalidates only the series whose input changed. */
  private readonly continueProjector = new ContinueProjector();
  private continued?: {
    projection: Library;
    shapes: Map<string, Shape>;
    shapeRevision: number;
    candidates: ContinueCandidate[];
  };
  private displayed?: {
    projection: Library;
    displays: Title[];
    shapes: Map<string, Shape>;
    displayRevision: number;
    shapeRevision: number;
    library: Library;
    recordIndexes: Map<string, number[]>;
    markIndexes: Map<string, number[]>;
    latestMarkIndexes: Map<string, number>;
    recordTitles: Map<string, Title>;
    markTitles: Map<string, Title>;
  };
  private namedContinue?: {
    projection: Library;
    candidates: ContinueCandidate[];
    library: Library;
    displayRevision: number;
    shapeRevision: number;
    entries: ContinueEntry[];
    candidateByKey: Map<string, ContinueCandidate>;
    entryByKey: Map<string, ContinueEntry>;
  };
  private displayIndex = new Map<string, Title>();
  private indexedDisplays = this.displays;
  private readonly displayBatches: string[][] = [];
  private readonly shapeBatches: string[][] = [];
  private readonly device = this.clock.device;
  /** SIMKL delivery is independent of the visible library. Hold its large snapshot behind foreground readiness. */
  private providersReady = false;
  private pendingSimkl?: LibraryLog;
  private deliveringSimkl?: Promise<void>;
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
            const before = this.log;
            const opened = await LibraryLog.openLocal(this.key);
            if (!opened) {
              if (this.log === before) this.log = null;
              return;
            }
            if (!(await this.publishOpened(before, opened, true))) return;
          }
          if (this.log && (await upgradeLibrary(this.log, true))) this.changed(true);
          return;
        }
        if (!this.log) {
          const before = this.log;
          const opened = await LibraryLog.open(this.key);
          if (!opened) {
            if (this.log === before) this.log = null;
            return;
          }
          if (!(await this.publishOpened(before, opened, true, true))) return;
          // The copy kept from the last visit shows at once; what changed since follows it.
          if (!opened.fromCache) return;
        }
        const log = this.log;
        if (!log) return;
        const settings = () =>
          JSON.stringify(['keys', 'plugins', 'prefs'].map((name) => log.settings(name)));
        const before = settings();
        if (await log.refresh()) this.changed(before !== settings());
        if (await upgradeLibrary(log, false)) this.changed(true);
        if (await switchLibraryToV4(log)) {
          this.changed(true);
          this.notify('Library updated to v4');
        }
        if (await log.compact()) this.changed(true);
        if (log.wireMinimum >= 3 && !log.readOnly) this.deferSimkl(log);
        await this.reconcileRecovery(log, this.key);
        if (log.wireMinimum >= 4 && !log.readOnly) {
          this.attachDownloads(log);
          // Only a page someone is looking at polls den-scout and drives the queue; a hidden one lets its lease lapse.
          // The lease holds only while each pass comes within 120 s of the last: `start` refreshes a visible page
          // every 30 s (5 s while something plays), so a renewal due at 60 s always lands. A tick slower than 120 s
          // would make den-core stop the hold, and the page would wait ten minutes to take it back.
          const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
          if (visible && (await driveDownloads(log, downloads, this.device))) this.changed();
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
    if (this.key === null || this.local)
      return () => {
        this.active = false;
      };
    let disposed = false;
    const refresh = async () => {
      if (document.hidden || disposed) return;
      await this.refresh();
      if (!disposed && this.log?.moved) onMoved();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let providersDue = false;
    const releaseProviders = () => {
      providersDue = true;
      if (!document.hidden) this.foregroundReady();
    };
    const providerTimer = setTimeout(releaseProviders, BACKGROUND_PROVIDER_FALLBACK_MS);
    const tick = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(() => void tick(), this.live ? LIVE_PULL_MS : 30_000);
    };
    void tick();
    window.addEventListener('online', refresh);
    const visible = () => {
      void refresh();
      if (providersDue && !document.hidden) this.foregroundReady();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      this.active = false;
      disposed = true;
      clearTimeout(timer);
      clearTimeout(providerTimer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }

  /**
   * The foreground has painted its critical hero. Release provider synchronization and poster availability now;
   * neither decides the shelves or hero, but both otherwise begin large/slow requests while those are loading.
   */
  foregroundReady(): void {
    if (!this.active || this.providersReady) return;
    this.providersReady = true;
    this.services.foregroundReady();
    this.startSimkl();
  }

  private deferSimkl(log: LibraryLog): void {
    this.pendingSimkl = log;
    if (this.providersReady) this.startSimkl();
  }

  /** One delivery at a time. A refresh arriving during it leaves one newest follow-up, never a request burst. */
  private startSimkl(): void {
    if (!this.providersReady || this.deliveringSimkl || !this.pendingSimkl) return;
    const log = this.pendingSimkl;
    this.pendingSimkl = undefined;
    const work = this.runSimkl(log);
    this.deliveringSimkl = work;
    void work.then(() => {
      if (this.deliveringSimkl === work) this.deliveringSimkl = undefined;
      if (this.pendingSimkl) this.startSimkl();
    });
  }

  private async runSimkl(log: LibraryLog): Promise<void> {
    try {
      if ((await deliverSimkl(log, this.device)) && this.active && this.log === log) this.changed();
    } catch (error) {
      console.warn('den: SIMKL delivery failed', error);
    }
  }
  changed(settings = false) {
    this.revision++;
    if (settings) this.settingsRevision++;
    downloads.touch();
  }

  /** Publish one naming batch and retain its keys, so projectors never have to diff the whole library. */
  publishLibraryMetadata(titles: Title[], shapes: ReadonlyArray<readonly [string, Shape]>): void {
    this.ensureDisplayIndex();
    const added: Title[] = [];
    for (const title of titles) {
      const key = `${title.type}:${title.id}`;
      if (this.displayIndex.has(key)) continue;
      this.displayIndex.set(key, title);
      added.push(title);
    }
    if (added.length) {
      this.displays = [...this.displays, ...added];
      this.indexedDisplays = this.displays;
      this.displayBatches.push(added.map((title) => `${title.type}:${title.id}`));
      this.displayRevision = this.displayBatches.length;
    }
    if (shapes.length) {
      const next = new Map(this.shapes);
      const changed: string[] = [];
      for (const [key, shape] of shapes) {
        if (next.get(key) === shape) continue;
        next.set(key, shape);
        changed.push(key);
      }
      if (changed.length) {
        this.shapes = next;
        this.shapeBatches.push(changed);
        this.shapeRevision = this.shapeBatches.length;
      }
    }
  }

  /** Remember metadata learned outside the background naming queue (for example, a pressed billboard card). */
  rememberTitle(title: Title): void {
    this.publishLibraryMetadata([title], []);
  }

  /** O(1) display lookup; reading it reacts only to display metadata, never to watch-state revisions. */
  displayTitle(ref: Pick<Title, 'type' | 'id'>): Title | undefined {
    void this.displayRevision;
    this.ensureDisplayIndex();
    return this.displayIndex.get(`${ref.type}:${ref.id}`);
  }

  /** The retained display index, for consumers that genuinely need all currently named titles. */
  displayTitles(): ReadonlyMap<string, Title> {
    void this.displayRevision;
    this.ensureDisplayIndex();
    return this.displayIndex;
  }

  private ensureDisplayIndex(): void {
    if (this.indexedDisplays === this.displays) return;
    this.displayIndex = new Map(this.displays.map((title) => [`${title.type}:${title.id}`, title]));
    this.indexedDisplays = this.displays;
  }

  private displayKeysSince(revision: number): Set<string> {
    return new Set(this.displayBatches.slice(revision).flat());
  }

  private shapeKeysSince(revision: number): Set<string> {
    return new Set(this.shapeBatches.slice(revision).flat());
  }

  /**
   * Build the first visible snapshot cooperatively, then install the log, revision and exact projection together.
   * The log is not exposed while this yields. If anything else replaced it meanwhile, this work is stale and is
   * discarded rather than publishing rows from one generation under another.
   */
  private async publishOpened(
    expected: LibraryLog | null | undefined,
    log: LibraryLog,
    settings: boolean,
    attachDownloads = false,
  ): Promise<boolean> {
    const expectedRevision = this.revision;
    const current = () =>
      this.active && this.log === expected && this.revision === expectedRevision;
    const rows = await log.rowsInSlices({ shouldContinue: current });
    if (!rows) return false;
    const library = await applyLogInSlices(emptyLibrary(), rows, { shouldContinue: current });
    if (!library || !current()) return false;
    const revision = this.revision + 1;
    if (attachDownloads) this.attachDownloads(log);
    this.projection = { revision, log, rows, library };
    this.log = log;
    this.changed(settings);
    return true;
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
    const displayRevision = this.displayRevision;
    const shapeRevision = this.shapeRevision;
    const displays = this.displays;
    const shapes = this.shapes;
    this.ensureDisplayIndex();
    const held = this.displayed;
    const untrackedDisplay =
      held?.displays !== displays && held?.displayRevision === displayRevision;
    const untrackedShape = held?.shapes !== shapes && held?.shapeRevision === shapeRevision;
    if (!held || held.projection !== projection || untrackedDisplay || untrackedShape) {
      const recordIndexes = new Map<string, number[]>();
      const markIndexes = new Map<string, number[]>();
      const latestMarkIndexes = new Map<string, number>();
      const recordTitles = new Map<string, Title>();
      const markTitles = new Map<string, Title>();
      const records = projection.records.map((record, index) => {
        const key = `${record.title.type}:${record.title.id}`;
        const indexes = recordIndexes.get(key) ?? [];
        indexes.push(index);
        recordIndexes.set(key, indexes);
        const title = this.displayIndex.get(key) ?? record.title;
        recordTitles.set(key, title);
        return title === record.title ? record : { ...record, title };
      });
      const marks = projection.marks.map((mark, index) => {
        const key = `${mark.type}:${mark.id}`;
        const indexes = markIndexes.get(key) ?? [];
        indexes.push(index);
        markIndexes.set(key, indexes);
        const latest = latestMarkIndexes.get(key);
        if (latest === undefined || projection.marks[latest]!.updatedAt < mark.updatedAt)
          latestMarkIndexes.set(key, index);
        const title = mark.title === '' ? this.displayIndex.get(key) : undefined;
        return title
          ? {
              ...mark,
              title: title.title,
              posterPath: title.posterPath,
              voteAverage: title.rating ?? 0,
            }
          : mark;
      });
      const library = { ...projection, records, marks, shapes };
      for (const [key, index] of latestMarkIndexes) {
        const mark = library.marks[index]!;
        markTitles.set(key, {
          type: mark.type as Title['type'],
          id: mark.id,
          title: mark.title,
          posterPath: mark.posterPath,
          rating: mark.voteAverage,
        });
      }
      this.displayed = {
        projection,
        displays,
        shapes,
        displayRevision,
        shapeRevision,
        library,
        recordIndexes,
        markIndexes,
        latestMarkIndexes,
        recordTitles,
        markTitles,
      };
      return library;
    }

    const changed = this.displayKeysSince(held.displayRevision);
    let records = held.library.records;
    let marks = held.library.marks;
    for (const key of changed) {
      const title = this.displayIndex.get(key);
      if (!title) continue;
      const recordIndexes = held.recordIndexes.get(key) ?? [];
      if (recordIndexes.length) {
        if (records === held.library.records) records = [...records];
        for (const index of recordIndexes) {
          const record = records[index]!;
          if (record.title !== title) records[index] = { ...record, title };
        }
        held.recordTitles.set(key, title);
      }
      const markIndexes = held.markIndexes.get(key) ?? [];
      const unnamedMarkIndexes = markIndexes.filter(
        (index) => projection.marks[index]!.title === '',
      );
      if (unnamedMarkIndexes.length) {
        if (marks === held.library.marks) marks = [...marks];
        for (const index of unnamedMarkIndexes) {
          const mark = marks[index]!;
          marks[index] = {
            ...mark,
            title: title.title,
            posterPath: title.posterPath,
            voteAverage: title.rating ?? 0,
          };
        }
        const latest = held.latestMarkIndexes.get(key);
        if (latest !== undefined) {
          const mark = marks[latest]!;
          held.markTitles.set(key, {
            type: mark.type as Title['type'],
            id: mark.id,
            title: mark.title,
            posterPath: mark.posterPath,
            rating: mark.voteAverage,
          });
        }
      }
    }
    if (records !== held.library.records || marks !== held.library.marks || held.shapes !== shapes)
      held.library = { ...held.library, records, marks, shapes };
    held.displays = displays;
    held.shapes = shapes;
    held.displayRevision = displayRevision;
    held.shapeRevision = shapeRevision;
    return held.library;
  }

  /** Keep the policy half shared by shelf naming and the visible Continue row. */
  private projectContinue(projection: Library): ContinueCandidate[] {
    const shapes = this.shapes;
    const shapeRevision = this.shapeRevision;
    const priorShapeRevision =
      this.continued?.projection === projection ? this.continued.shapeRevision : 0;
    if (
      !this.continued ||
      this.continued.projection !== projection ||
      this.continued.shapes !== shapes
    ) {
      this.continued = {
        projection,
        shapes,
        shapeRevision,
        candidates:
          this.continued?.projection === projection && priorShapeRevision < shapeRevision
            ? this.continueProjector.projectShapeChanges(
                { ...projection, shapes },
                this.shapeKeysSince(priorShapeRevision),
              )
            : this.continueProjector.project({ ...projection, shapes }),
      };
    }
    return this.continued.candidates;
  }

  /** Ordered shelf membership without naming display fields. */
  continueTitleRefs(projection: Library): Array<Pick<Title, 'type' | 'id'>> {
    return this.projectContinue(projection).map(({ ref }) => ({ type: ref.type, id: ref.id }));
  }

  /** Continue Watching from the same shared projection, recomputing only changed per-series policy inputs. */
  continueWatching(projection: Library, displayed: Library): ContinueEntry[] {
    const displayRevision = this.displayRevision;
    const shapeRevision = this.shapeRevision;
    const candidates = this.projectContinue(projection);
    const named = this.namedContinue;
    const currentDisplay = this.displayed;
    const untrackedMetadata =
      named?.library !== displayed &&
      named?.displayRevision === displayRevision &&
      named?.shapeRevision === shapeRevision;
    if (!named || named.projection !== projection || !currentDisplay || untrackedMetadata) {
      const entries = nameContinueCandidates(candidates, displayed);
      this.namedContinue = {
        projection,
        candidates,
        library: displayed,
        displayRevision,
        shapeRevision,
        entries,
        candidateByKey: new Map(
          candidates.map((candidate) => [`${candidate.ref.type}:${candidate.ref.id}`, candidate]),
        ),
        entryByKey: new Map(
          entries.map((entry) => [`${entry.title.type}:${entry.title.id}`, entry]),
        ),
      };
      return entries;
    }

    const affected = this.displayKeysSince(named.displayRevision);
    for (const key of this.shapeKeysSince(named.shapeRevision)) affected.add(key);
    if (named.candidates !== candidates) {
      for (const key of affected) {
        const candidate = candidates.find((entry) => `${entry.ref.type}:${entry.ref.id}` === key);
        if (candidate) named.candidateByKey.set(key, candidate);
        else named.candidateByKey.delete(key);
      }
      named.candidates = candidates;
    }
    if (affected.size) {
      for (const key of affected) {
        const candidate = named.candidateByKey.get(key);
        const previous = named.entryByKey.get(key);
        const title = candidate
          ? candidate.display === 'mark'
            ? currentDisplay.markTitles.get(key)
            : currentDisplay.recordTitles.get(key)
          : undefined;
        if (candidate && title?.title) {
          const { ref: _ref, display: _display, ...entry } = candidate;
          named.entryByKey.set(key, { ...entry, title });
        } else if (previous) named.entryByKey.delete(key);
      }
      named.entries = candidates.flatMap((candidate) => {
        const entry = named.entryByKey.get(`${candidate.ref.type}:${candidate.ref.id}`);
        return entry ? [entry] : [];
      });
    }
    named.displayRevision = displayRevision;
    named.shapeRevision = shapeRevision;
    named.library = displayed;
    return named.entries;
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
/* eslint-enable svelte/prefer-svelte-reactivity */

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
