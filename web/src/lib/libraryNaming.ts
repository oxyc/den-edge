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
import { yieldTask } from './taskYield';
import type { ActiveHomePayload } from './homeLibraryView';

interface NamedLibrary {
  displays: Title[];
  shapes: Map<string, Shape>;
  /** Reuse a session's retained policy projection instead of folding the whole library again for shelf naming. */
  continueTitleRefs?(library: Library): Ref[];
  /** Sessions use this to publish one keyed metadata batch without making every consumer diff snapshots. */
  publishLibraryMetadata?: (
    titles: Title[],
    shapes: ReadonlyArray<readonly [string, Shape]>,
  ) => void;
  /** Compact startup state, replaced after exact shape projection without materializing the full log. */
  activeHome?: ActiveHomePayload | null;
  settleActiveHomeContinue?(): Promise<void>;
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
  /** Undefined until the first active idle turn when this job was supplied lazily. */
  refs?: Map<string, Ref>;
  source?: () => Ref[];
  /** Keys claimed before a lazy source is enumerated must not re-enter its queue afterward. */
  skipped: Set<string>;
  owns?: (ref: Ref) => boolean;
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
export interface ShelfPlan {
  continue: boolean;
  watchlist: boolean;
}
export interface ShelfNaming {
  /** Membership known without metadata: Watchlist is exact; Continue awaits policy-critical TV shapes. */
  initialPlan: ShelfPlan;
  /** Exact shelf presence, available before any display names are published. */
  planned: Promise<ShelfPlan>;
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
  /** Exact cheap membership check used to promote a direct route before a lazy source is enumerated. */
  owns?: (ref: { type: MediaType; id: number }) => boolean;
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
  return !job.cancelled && job.active && !job.hidden() && job.refs?.size !== 0;
}

function removeBackgroundRef(run: NamingRun, id: string): void {
  for (const job of run.background) {
    job.skipped.add(id);
    job.refs?.delete(id);
  }
}

function removeShelfRef(run: NamingRun, id: string): void {
  for (const job of run.shelves) job.refs.delete(id);
}

function nextBackground(run: NamingRun): Ref | undefined {
  for (const job of run.background) {
    if (!usable(job)) continue;
    if (!job.refs) {
      const refs = job.source?.() ?? [];
      job.source = undefined;
      job.refs = new Map(
        refs.flatMap((ref) => {
          const id = titleKey(ref);
          return job.skipped.has(id) ? [] : [[id, ref] as const];
        }),
      );
    }
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
  yieldToBrowser: () => Promise<void> = yieldTask,
): ShelfNaming {
  const run = namingRun(session, key);
  // This is also the exact seed set published after shape preflight. Selecting it twice used to scan and sort the
  // whole title history twice during startup.
  const seeds = personalSeedRows(rows);
  const critical = shelfTitleRefs(library, rows, seeds);
  const requiredShapes = shapeRefs(library, critical);
  // The session-owned projector retains this fold and later applies only the shapes published below. Lightweight
  // fixtures without one get the same property from one projector local to this naming run.
  const fallbackProjector = new ContinueProjector();
  const continueQueue = () => {
    const continued =
      session.continueTitleRefs?.(library) ??
      fallbackProjector.project({ ...library, shapes: session.shapes }).map(({ ref }) => ({
        type: ref.type,
        id: ref.id,
      }));
    return uniqueRefs(continued);
  };
  const watchlistQueue = uniqueRefs(
    library.records
      .filter((record) => !record.deleted && record.status === 'watchlist')
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(({ title }) => ({ type: title.type, id: title.id })),
  );
  const initialQueues = { continue: continueQueue(), watchlist: watchlistQueue };
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
  const initialPlan: ShelfPlan = {
    // A movie in progress or a TV episode that can be resumed is a conclusive positive without a season layout.
    // Only a negative answer can still depend on the policy-critical shapes below.
    continue: initialQueues.continue.length > 0,
    watchlist: initialQueues.watchlist.length > 0,
  };
  let planSettled = false;
  let resolvePlan!: (plan: ShelfPlan) => void;
  const planned = new Promise<ShelfPlan>((resolve) => (resolvePlan = resolve));
  const settlePlan = (plan: ShelfPlan) => {
    if (planSettled) return;
    planSettled = true;
    resolvePlan(plan);
  };
  if (initialPlan.continue) settlePlan(initialPlan);

  const ready = (async () => {
    try {
      await nameLibraryShapes(session, requiredShapes, key, lookup);
      if (job.cancelled || runs.get(session) !== run) return;

      // With no shape work, reuse the initial projection exactly. Production's session projector also makes the
      // shaped path incremental, rather than replaying the whole library after metadata arrives.
      // Shapes can change Continue membership, but never Watchlist. Keep the already ordered Watchlist queue rather
      // than scanning and sorting every record a second time.
      queues = requiredShapes.length
        ? { continue: continueQueue(), watchlist: initialQueues.watchlist }
        : initialQueues;
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
      settlePlan({ continue: queues.continue.length > 0, watchlist: queues.watchlist.length > 0 });

      // Let the fixed shelf geometry paint before fetching and publishing the first display tranche.
      await yieldToBrowser();
      if (job.cancelled || runs.get(session) !== run) return;
      await nameLibraryTitles(session, initial, key, lookup);
      // Keep the reactive metadata publication and the component swap in separate browser tasks.
      await yieldToBrowser();
      if (job.cancelled || runs.get(session) !== run) return;
    } finally {
      // Cancellation or an unexpected lookup failure must never leave a Home loader waiting on the plan.
      settlePlan({ continue: false, watchlist: false });
    }
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
    initialPlan,
    planned,
    ready,
    admit,
    drain,
    get refs() {
      return visibleRefs;
    },
    cancel() {
      if (job.cancelled) return;
      job.cancelled = true;
      settlePlan({ continue: false, watchlist: false });
      job.refs.clear();
      run.shelves.delete(job);
    },
  };
}

const refOfKey = (key: string): Ref | undefined => {
  const match = /^(movie|tv):(\d+)$/.exec(key);
  const id = Number(match?.[2]);
  return match && Number.isSafeInteger(id) && id > 0
    ? { type: match[1] as MediaType, id }
    : undefined;
};

/** The same bounded shelf naming lifecycle when policy membership came from the retained startup engine. */
export function nameActiveHomeShelfTitles(
  session: NamedLibrary,
  payload: ActiveHomePayload,
  key: string,
  lookup: typeof fetchDetails = fetchDetails,
  yieldToBrowser: () => Promise<void> = yieldTask,
): ShelfNaming {
  const run = namingRun(session, key);
  const refs = (keys: string[]) => keys.flatMap((value) => refOfKey(value) ?? []);
  const seedRefs = refs([...payload.view.seeds.watched, ...payload.view.seeds.watchlisted]);
  const watchlistQueue = refs(payload.view.watchlist);
  let queues: Record<ShelfName, Ref[]> = {
    continue: payload.view.continue.map(({ ref }) => ref),
    watchlist: watchlistQueue,
  };
  const critical = refs(payload.view.shelfRefs);
  const requiredShapes = refs(payload.view.requiredShapeRefs);
  const job: ShelfJob = {
    refs: new Map(critical.map((ref) => [titleKey(ref), ref])),
    cancelled: false,
  };
  run.shelves.add(job);
  let visibleRefs: Ref[] = [];
  let admissions = Promise.resolve();
  let draining: Promise<void> | undefined;
  const initialPlan: ShelfPlan = {
    continue: queues.continue.length > 0,
    watchlist: queues.watchlist.length > 0,
  };
  let planSettled = false;
  let resolvePlan!: (plan: ShelfPlan) => void;
  const planned = new Promise<ShelfPlan>((resolve) => (resolvePlan = resolve));
  const settlePlan = (plan: ShelfPlan) => {
    if (planSettled) return;
    planSettled = true;
    resolvePlan(plan);
  };
  if (initialPlan.continue) settlePlan(initialPlan);

  const ready = (async () => {
    try {
      await nameLibraryShapes(session, requiredShapes, key, lookup);
      await session.settleActiveHomeContinue?.();
      if (job.cancelled || runs.get(session) !== run) return;
      const exact =
        session.activeHome?.handle === payload.handle ? session.activeHome.view : undefined;
      // `payload` stays valid when a lightweight caller has no live active state; production reads the exact reply.
      const view = exact ?? session.activeHome?.view ?? payload.view;
      queues = {
        continue: view.continue.map(({ ref }) => ref),
        watchlist: watchlistQueue,
      };
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
      settlePlan({ continue: queues.continue.length > 0, watchlist: queues.watchlist.length > 0 });
      await yieldToBrowser();
      if (job.cancelled || runs.get(session) !== run) return;
      await nameLibraryTitles(session, initial, key, lookup);
      await yieldToBrowser();
    } finally {
      settlePlan({ continue: false, watchlist: false });
    }
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
  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      await ready;
      while (!job.cancelled && job.refs.size) {
        const before = job.refs.size;
        await admit('continue');
        await admit('watchlist');
        if (job.refs.size === before) break;
        if (job.refs.size) await new Promise<void>((resolve) => browserIdle(resolve));
      }
    })().finally(() => (draining = undefined));
    return draining;
  };
  return {
    initialPlan,
    planned,
    ready,
    admit,
    drain,
    get refs() {
      return visibleRefs;
    },
    cancel() {
      if (job.cancelled) return;
      job.cancelled = true;
      settlePlan({ continue: false, watchlist: false });
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
    ![...run.background].some(
      (job) => job.refs?.has(id) || (!job.refs && !job.skipped.has(id) && job.owns?.(ref)),
    ) &&
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
  refs: Ref[] | (() => Ref[]),
  key: string,
  options: BackgroundNamingOptions = {},
): BackgroundNaming {
  const run = namingRun(session, key);
  const lookup = options.lookup ?? fetchDetails;
  const job: BackgroundJob = {
    ...(typeof refs === 'function'
      ? { source: refs }
      : { refs: new Map(refs.map((ref) => [titleKey(ref), ref])) }),
    skipped: new Set(),
    owns: options.owns,
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
      job.refs?.clear();
      job.stopVisibility();
      run.background.delete(job);
      refresh();
    },
  };
}

/** Select by log recency before looking up names: network order must never select the recommendation seeds. */
export function personalSeedRows(rows: Row[]) {
  const recency = (r: TitleRow) => Math.max(r.watchedAt ?? 0, r.reaction.at[0], r.addedAt);
  const compare = (a: TitleRow, b: TitleRow) =>
    recency(b) - recency(a) || titleKey(a.title).localeCompare(titleKey(b.title));
  const watched: TitleRow[] = [];
  const watchlisted: TitleRow[] = [];
  const offer = (latest: TitleRow[], row: TitleRow) => {
    const at = latest.findIndex((held) => compare(row, held) < 0);
    if (at < 0) {
      if (latest.length < 2) latest.push(row);
      return;
    }
    latest.splice(at, 0, row);
    if (latest.length > 2) latest.pop();
  };
  for (const row of rows) {
    if (row.kind !== 'rec' || row.deleted.value) continue;
    if (
      row.status.value === 'watched' ||
      row.reaction.value === 'like' ||
      row.reaction.value === 'love'
    )
      offer(watched, row);
    if (row.status.value === 'watchlist') offer(watchlisted, row);
  }
  return { watched, watchlisted };
}

/** Only titles that can determine a visible shelf; older watched history can be named afterward. */
export function shelfTitleRefs(
  library: Library,
  rows: Row[],
  seeds = personalSeedRows(rows),
): Ref[] {
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
