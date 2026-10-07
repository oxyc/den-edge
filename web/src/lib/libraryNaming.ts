import {
  ContinueProjector,
  titleKey,
  type Library,
  type MediaType,
  type Shape,
  type Title,
} from './library';
import type { Row, TitleRow } from './wire';
import { fetchDetails, type Details } from './tmdb';

interface NamedLibrary {
  displays: Title[];
  shapes: Map<string, Shape>;
  /** Sessions use this to publish one keyed metadata batch without making every consumer diff snapshots. */
  publishLibraryMetadata?: (
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
  ) => void;
}
type Ref = { type: MediaType; id: number };
interface NamingRun {
  key: string;
  pending: Map<string, Promise<void>>;
  displays: Title[];
  known: Set<string>;
  /** Found but not yet published: every assignment re-derives the whole Home, so names land together. */
  found: Map<string, Details>;
  /** Details fetched for shelf correctness whose display stays dormant until that shelf admits it. */
  resolved: Map<string, Details>;
  /** Display keys allowed into the reactive library. Shapes are always allowed through. */
  admitted: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  background: Set<BackgroundJob>;
  shelves: Set<ShelfJob>;
  backgroundPending: Set<string>;
  idle?: () => void;
}
interface BackgroundJob {
  refs: Map<string, Ref>;
  active: boolean;
  cancelled: boolean;
  scheduleIdle: (task: () => void) => () => void;
  hidden: () => boolean;
  stopVisibility: () => void;
}
interface ShelfJob {
  refs: Map<string, Ref>;
  cancelled: boolean;
}
export interface BackgroundNaming {
  pause(): void;
  resume(): void;
  cancel(): void;
}
export type ShelfName = 'continue' | 'watchlist';
export interface ShelfNaming {
  /** Initial names and every shape that can decide Continue Watching have been published. */
  ready: Promise<void>;
  /** Admit one bounded tranche for the shelf the viewer is moving through. */
  admit(shelf: ShelfName): Promise<void>;
  /** Fill both shelves cooperatively for a screen that lists the whole library. */
  drain(): Promise<void>;
  /** Every display ref owned by the visible shelves, including the initial tranche. */
  refs: readonly Ref[];
  cancel(): void;
}
export interface BackgroundNamingOptions {
  lookup?: typeof fetchDetails;
  /** Test seam for the browser idle callback. Returns its cancellation function. */
  scheduleIdle?: (task: () => void) => () => void;
  /** Test seam for document visibility. */
  hidden?: () => boolean;
  onVisibilityChange?: (task: () => void) => () => void;
}
// Retained pages share pending work; weak ownership releases it with the paired library.
const runs = new WeakMap<NamedLibrary, NamingRun>();
/** How long found names gather before they are published together. */
const BATCH_MS = 100;
const BACKGROUND_LOOKUPS = 2;
/** Eight per shelf covers a desktop viewport; two shelves plus the (usually overlapping) taste seeds stay <= 20. */
export const INITIAL_SHELF_TITLES = 8;
/** One interaction cannot turn a cached long shelf back into one large Svelte publication. */
export const SHELF_TRANCHE = 8;

function browserIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(task, { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 200);
  return () => clearTimeout(id);
}

const documentHidden = () => typeof document !== 'undefined' && document.hidden;
function onDocumentVisibility(task: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', task);
  return () => document.removeEventListener('visibilitychange', task);
}

function stopBackground(run: NamingRun): void {
  run.idle?.();
  run.idle = undefined;
  for (const job of run.background) job.stopVisibility();
  run.background.clear();
}

function usable(job: BackgroundJob): boolean {
  return !job.cancelled && job.active && !job.hidden() && job.refs.size > 0;
}

function removeBackgroundRef(run: NamingRun, id: string): void {
  for (const job of run.background) job.refs.delete(id);
}

function removeShelfRef(run: NamingRun, id: string): void {
  for (const job of run.shelves) job.refs.delete(id);
}

function nextBackground(run: NamingRun): Ref | undefined {
  for (const job of run.background) {
    if (!usable(job)) continue;
    const ref = job.refs.values().next().value as Ref | undefined;
    if (ref) return ref;
  }
}

function scheduleBackground(
  session: NamedLibrary,
  run: NamingRun,
  lookup: typeof fetchDetails,
): void {
  if (runs.get(session) !== run || run.idle || run.backgroundPending.size >= BACKGROUND_LOOKUPS)
    return;
  const owner = [...run.background].find(usable);
  if (!owner) return;
  run.idle = owner.scheduleIdle(() => {
    run.idle = undefined;
    if (runs.get(session) !== run) return;
    while (run.backgroundPending.size < BACKGROUND_LOOKUPS) {
      const ref = nextBackground(run);
      if (!ref) break;
      const id = titleKey(ref);
      removeBackgroundRef(run, id);
      if (
        run.found.has(id) ||
        (knownTitles(session, run).has(id) && (ref.type !== 'tv' || session.shapes.has(id)))
      )
        continue;
      const existing = run.pending.get(id);
      if (existing) {
        void existing.finally(() => scheduleBackground(session, run, lookup));
        continue;
      }
      run.backgroundPending.add(id);
      void requestName(session, run, ref, lookup).finally(() => {
        run.backgroundPending.delete(id);
        scheduleBackground(session, run, lookup);
      });
    }
  });
}

/** Title membership for the current display snapshot, shared by every retained page's naming pass. */
function knownTitles(session: NamedLibrary, run: NamingRun): Set<string> {
  if (run.displays !== session.displays) {
    run.displays = session.displays;
    run.known = new Set(session.displays.map(titleKey));
  }
  return run.known;
}

/** Every name found since the last publish, in one assignment each to `displays` and `shapes`. */
function publish(session: NamedLibrary, run: NamingRun): void {
  clearTimeout(run.timer);
  run.timer = undefined;
  const found = [...run.found];
  run.found.clear();
  if (runs.get(session) !== run || !found.length) return;
  // A user action may have remembered a title while its metadata was loading.
  const known = knownTitles(session, run);
  const titles = found
    .filter(([id]) => run.admitted.has(id) && !known.has(id))
    .map(([, details]) => details.title);
  const shapes = found.flatMap(([id, { shape }]) => (shape ? [[id, shape] as const] : []));
  if (session.publishLibraryMetadata) session.publishLibraryMetadata(titles, shapes);
  else {
    if (titles.length) session.displays = [...session.displays, ...titles];
    if (shapes.length) session.shapes = new Map([...session.shapes, ...shapes]);
  }
  if (titles.length) {
    run.displays = session.displays;
    for (const title of titles) known.add(titleKey(title));
  }
  for (const [id, details] of found) {
    if (run.admitted.has(id) && known.has(id) && (!details.shape || session.shapes.has(id)))
      run.resolved.delete(id);
  }
}

function namingRun(session: NamedLibrary, key: string): NamingRun {
  let run = runs.get(session);
  if (!run || run.key !== key) {
    if (run) stopBackground(run);
    const displays = session.displays;
    run = {
      key,
      pending: new Map(),
      displays,
      known: new Set(displays.map(titleKey)),
      found: new Map(),
      resolved: new Map(),
      admitted: new Set(),
      background: new Set(),
      shelves: new Set(),
      backgroundPending: new Set(),
    };
    runs.set(session, run);
  }
  return run;
}

function requestName(
  session: NamedLibrary,
  run: NamingRun,
  ref: Ref,
  lookup: typeof fetchDetails,
  admitTitle = true,
): Promise<void> {
  const id = titleKey(ref);
  removeBackgroundRef(run, id);
  if (admitTitle) {
    removeShelfRef(run, id);
    run.admitted.add(id);
  }
  const resolved = run.resolved.get(id);
  if (resolved) {
    run.found.set(id, resolved);
    run.timer ??= setTimeout(() => publish(session, run), BATCH_MS);
    return Promise.resolve();
  }
  let work = run.pending.get(id);
  if (!work) {
    const requested = ref;
    work = Promise.resolve()
      .then(() => lookup(requested, run.key))
      .then((found) => {
        if (!found || runs.get(session) !== run) return;
        run.resolved.set(id, found);
        run.found.set(id, found);
        run.timer ??= setTimeout(() => publish(session, run), BATCH_MS);
      })
      .catch(() => {})
      .finally(() => run.pending.delete(id));
    run.pending.set(id, work);
  }
  return work;
}

export async function nameLibraryTitles(
  session: NamedLibrary,
  refs: Ref[],
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): Promise<void> {
  const run = namingRun(session, key);
  const current = run;
  const queue = [...refs];
  let next = 0;
  const worker = async () => {
    for (let ref = queue[next++]; ref; ref = queue[next++]) {
      if (runs.get(session) !== current) return;
      const id = titleKey(ref);
      if (
        current.found.has(id) ||
        (knownTitles(session, current).has(id) && (ref.type !== 'tv' || session.shapes.has(id)))
      )
        continue;
      await requestName(session, current, ref, lookup);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  publish(session, current);
}

/** Fetch policy-critical TV layouts without exposing every fetched display to Svelte at once. */
async function nameLibraryShapes(
  session: NamedLibrary,
  refs: Ref[],
  key: string,
  lookup: typeof fetchDetails,
): Promise<void> {
  const run = namingRun(session, key);
  const current = run;
  const queue = refs.filter((ref) => ref.type === 'tv');
  let next = 0;
  const worker = async () => {
    for (let ref = queue[next++]; ref; ref = queue[next++]) {
      if (runs.get(session) !== current) return;
      const id = titleKey(ref);
      if (session.shapes.has(id)) continue;
      await requestName(session, current, ref, lookup, false);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  publish(session, current);
}

const uniqueRefs = (refs: Ref[]): Ref[] => [
  ...new Map(refs.map((ref) => [titleKey(ref), { type: ref.type, id: ref.id }])).values(),
];

function shapeRefs(library: Library, critical: readonly Ref[]): Ref[] {
  const needed = new Set(
    uniqueRefs([
      ...library.marks.flatMap((mark) =>
        mark.type === 'tv' ? [{ type: 'tv' as const, id: mark.id }] : [],
      ),
      ...[...(library.flags?.values() ?? [])].flatMap((flag) =>
        flag.type === 'tv' ? [{ type: 'tv' as const, id: flag.id }] : [],
      ),
    ]).map(titleKey),
  );
  // Stay inside v0.263's existing pre-ready request set: flag-only history must not reopen cold TMDB fanout.
  return critical.filter((ref) => ref.type === 'tv' && needed.has(titleKey(ref)));
}

function shelfQueues(library: Library): Record<ShelfName, Ref[]> {
  const continued = new ContinueProjector().project(library).map(({ ref }) => ({
    type: ref.type,
    id: ref.id,
  }));
  const saved = library.records
    .filter((record) => !record.deleted && record.status === 'watchlist')
    .sort((a, b) => b.addedAt - a.addedAt)
    .map(({ title }) => ({ type: title.type, id: title.id }));
  return { continue: uniqueRefs(continued), watchlist: uniqueRefs(saved) };
}

/**
 * Keep shelf membership eager but bound display publication to what Home can initially show. TV layouts are
 * fetched first and published without their titles, so completed-series decisions and exact Continue ordering
 * are known before `ready`. The dormant names already fetched with those layouts are reused on later intent.
 */
export function nameLibraryShelfTitles(
  session: NamedLibrary,
  library: Library,
  rows: Row[],
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): ShelfNaming {
  const run = namingRun(session, key);
  const critical = shelfTitleRefs(library, rows);
  const job: ShelfJob = {
    // Own every former shelf-critical ref until shapes reveal the exact two visible queues. This also lets a
    // retained title route promote its own key while the initial pass is still running.
    refs: new Map(critical.map((ref) => [titleKey(ref), ref])),
    cancelled: false,
  };
  run.shelves.add(job);
  let queues: Record<ShelfName, Ref[]> = { continue: [], watchlist: [] };
  let visibleRefs: Ref[] = [];
  let admissions = Promise.resolve();
  let draining: Promise<void> | undefined;

  const ready = (async () => {
    await nameLibraryShapes(session, shapeRefs(library, critical), key, lookup);
    if (job.cancelled || runs.get(session) !== run) return;

    queues = shelfQueues({ ...library, shapes: session.shapes });
    const seeds = personalSeedRows(rows);
    const seedRefs = [...seeds.watched, ...seeds.watchlisted].map(({ title }) => title);
    visibleRefs = uniqueRefs([...seedRefs, ...queues.continue, ...queues.watchlist]);
    const initial = uniqueRefs([
      ...seedRefs,
      ...queues.continue.slice(0, INITIAL_SHELF_TITLES),
      ...queues.watchlist.slice(0, INITIAL_SHELF_TITLES),
    ]);
    const initialKeys = new Set(initial.map(titleKey));
    const known = knownTitles(session, run);
    job.refs = new Map(
      visibleRefs.flatMap((ref) => {
        const id = titleKey(ref);
        return initialKeys.has(id) || run.admitted.has(id) || known.has(id)
          ? []
          : [[id, ref] as const];
      }),
    );
    await nameLibraryTitles(session, initial, key, lookup);
  })();

  const take = (shelf: ShelfName): Ref[] => {
    const batch: Ref[] = [];
    for (const ref of queues[shelf]) {
      const id = titleKey(ref);
      if (!job.refs.has(id)) continue;
      job.refs.delete(id);
      batch.push(ref);
      if (batch.length === SHELF_TRANCHE) break;
    }
    return batch;
  };
  const admit = (shelf: ShelfName): Promise<void> => {
    admissions = Promise.all([ready, admissions]).then(async () => {
      if (job.cancelled || runs.get(session) !== run) return;
      const batch = take(shelf);
      if (batch.length) await nameLibraryTitles(session, batch, key, lookup);
    });
    return admissions;
  };
  const idleTurn = () =>
    new Promise<void>((resolve) => {
      browserIdle(resolve);
    });
  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      await ready;
      while (!job.cancelled && job.refs.size) {
        const before = job.refs.size;
        await admit('continue');
        await admit('watchlist');
        if (job.refs.size === before) break;
        if (job.refs.size) await idleTurn();
      }
    })().finally(() => (draining = undefined));
    return draining;
  };

  return {
    ready,
    admit,
    drain,
    get refs() {
      return visibleRefs;
    },
    cancel() {
      if (job.cancelled) return;
      job.cancelled = true;
      job.refs.clear();
      run.shelves.delete(job);
    },
  };
}

/** Promote only a title already owned by this run's background tail; unrelated card intent starts no new work. */
export function promoteLibraryTitle(
  session: NamedLibrary,
  ref: Ref,
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
): Promise<void> | undefined {
  const run = runs.get(session);
  if (!run || run.key !== key) return;
  const id = titleKey(ref);
  if (
    !run.pending.has(id) &&
    ![...run.background].some((job) => job.refs.has(id)) &&
    ![...run.shelves].some((job) => job.refs.has(id))
  )
    return;
  if (
    run.found.has(id) ||
    (knownTitles(session, run).has(id) && (ref.type !== 'tv' || session.shapes.has(id)))
  ) {
    removeBackgroundRef(run, id);
    publish(session, run);
    return Promise.resolve();
  }
  const work = requestName(session, run, ref, lookup);
  return work.then(() => publish(session, run));
}

/**
 * Name the unreserved watched-history tail only while its route and document are active. Each request is admitted
 * by an idle callback, and all retained routes sharing this session share the same two-request ceiling.
 */
export function nameLibraryHistoryTitles(
  session: NamedLibrary,
  refs: Ref[],
  key: string,
  options: BackgroundNamingOptions = {},
): BackgroundNaming {
  const run = namingRun(session, key);
  const lookup = options.lookup ?? fetchDetails;
  const job: BackgroundJob = {
    refs: new Map(refs.map((ref) => [titleKey(ref), ref])),
    active: true,
    cancelled: false,
    scheduleIdle: options.scheduleIdle ?? browserIdle,
    hidden: options.hidden ?? documentHidden,
    stopVisibility: () => {},
  };
  const refresh = () => {
    if (runs.get(session) !== run) return;
    if (!usable(job)) {
      // A shared idle callback may belong to this job. Re-admit it from another active owner if there is one.
      run.idle?.();
      run.idle = undefined;
    }
    scheduleBackground(session, run, lookup);
  };
  job.stopVisibility = (options.onVisibilityChange ?? onDocumentVisibility)(refresh);
  run.background.add(job);
  scheduleBackground(session, run, lookup);
  return {
    pause() {
      job.active = false;
      refresh();
    },
    resume() {
      job.active = true;
      refresh();
    },
    cancel() {
      if (job.cancelled) return;
      job.cancelled = true;
      job.refs.clear();
      job.stopVisibility();
      run.background.delete(job);
      refresh();
    },
  };
}

/** Select by log recency before looking up names: network order must never select the recommendation seeds. */
export function personalSeedRows(rows: Row[]) {
  const titles = rows.filter((r): r is TitleRow => r.kind === 'rec' && !r.deleted.value);
  const recency = (r: TitleRow) => Math.max(r.watchedAt ?? 0, r.reaction.at[0], r.addedAt);
  const latest = (keep: (r: TitleRow) => boolean) =>
    titles
      .filter(keep)
      .sort((a, b) => recency(b) - recency(a) || titleKey(a.title).localeCompare(titleKey(b.title)))
      .slice(0, 2);
  return {
    watched: latest(
      (r) =>
        r.status.value === 'watched' || r.reaction.value === 'like' || r.reaction.value === 'love',
    ),
    watchlisted: latest((r) => r.status.value === 'watchlist'),
  };
}

/** Only titles that can determine a visible shelf; older watched history can be named afterward. */
export function shelfTitleRefs(library: Library, rows: Row[]): Ref[] {
  const seeds = personalSeedRows(rows);
  const refs: Ref[] = [...seeds.watched, ...seeds.watchlisted].map((r) => r.title);
  refs.push(
    ...library.records
      .filter((r) => !r.deleted && (r.status === 'watchlist' || r.status === 'inProgress'))
      .map((r) => r.title),
  );
  refs.push(
    ...library.marks.filter(
      (m): m is typeof m & { type: 'tv' | 'movie' } => m.type === 'tv' || m.type === 'movie',
    ),
  );
  return [...new Map(refs.map((ref) => [titleKey(ref), { type: ref.type, id: ref.id }])).values()];
}
