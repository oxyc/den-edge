import type { Library, Shape } from './library';
import type {
  ActiveHomePayload,
  ActiveHomeHydrationChunk,
  ActiveHomeShapeReply,
  HomeLibraryViewProof,
} from './homeLibraryView';
import type { Row, Stamp } from './wire';
import { yieldTask } from './taskYield';

const HOME_VIEW_PROOF = import.meta.env.DEV && import.meta.env.VITE_HOME_VIEW_PROOF === '1';

interface ProjectedRows {
  rows: Row[];
  stamp: Stamp;
  reconsiderAt: number;
  /** The instant at which future document stamps were judged believable. */
  at: number;
}

interface ProjectedLibrary extends ProjectedRows {
  library: Library;
  /** Development-only proof; production Workers omit it and callers ignore it. */
  homeView?: HomeLibraryViewProof;
}

interface OpenedProjection extends ProjectedLibrary {
  /** The raw rows used for this projection. They share identity with `opened.entries` in the same clone graph. */
  source: Row[];
}

/** A projection reply carries its first fold so the next startup step does not clone the same rows back again. */
const projectedLibraries = new WeakMap<Row[], Library>();
const projectedHomeViews = new WeakMap<Row[], HomeLibraryViewProof>();

interface WorkerReply {
  id: number;
  value?: unknown;
  error?: string;
}

interface OpenedValue<T> {
  opened: T;
  retainedId?: number;
  projected?: OpenedProjection;
}

interface RetainedRow {
  id: number;
  index: number;
}

type Waiting = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, Waiting>();
// Structured cloning preserves shared identity inside one reply graph. It tells us whether LibraryLog is projecting
// exactly the opened rows (and may reuse that reply's projection) or journal work replaced any of them. The retained
// map is the fallback for Workers that opened successfully but could not complete the combined projection.
const retainedRows = new WeakMap<object, RetainedRow>();
const openedProjections = new WeakMap<object, { projection: OpenedProjection; index: number }>();

function failed(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function stop(error: unknown): void {
  const reason = failed(error);
  worker?.terminate();
  worker = undefined;
  for (const pending of waiting.values()) pending.reject(reason);
  waiting.clear();
}

function sharedWorker(): Worker | undefined {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return undefined;
  try {
    const made = new Worker(new URL('./libraryWorker.ts', import.meta.url), { type: 'module' });
    made.onmessage = (event: MessageEvent<WorkerReply>) => {
      const pending = waiting.get(event.data.id);
      if (!pending) return;
      waiting.delete(event.data.id);
      if (event.data.error !== undefined) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.value);
    };
    made.onerror = (event) => stop(event.error ?? event.message);
    made.onmessageerror = () => stop(new Error('library worker reply could not be read'));
    worker = made;
    return made;
  } catch {
    return undefined;
  }
}

function ask<T>(
  message: Record<string, unknown>,
  transfer: Transferable[] = [],
): Promise<T> | null {
  const target = sharedWorker();
  if (!target) return null;
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    try {
      target.postMessage({ id, ...message }, transfer);
    } catch (error) {
      waiting.delete(id);
      reject(failed(error));
    }
  });
}

/**
 * Open a cached library to the first-paint Home contract only. The decrypted snapshot and full fold stay in the
 * Worker under `handle` until the caller either hydrates the ordinary log or releases it.
 */
export async function openActiveHomeInWorker(
  key: CryptoKey,
  name: string,
  bytes: Uint8Array,
  now = Date.now(),
): Promise<ActiveHomePayload | undefined> {
  const copy = bytes.slice();
  const request = ask<ActiveHomePayload>(
    { op: 'open-active-home', key, name, bytes: copy.buffer, now },
    [copy.buffer],
  );
  if (!request) return undefined;
  try {
    return await request;
  } catch {
    return undefined;
  }
}

/** Exact Continue candidates after Home's policy-critical TV layouts arrive. */
export async function projectActiveHomeShapes(
  handle: number,
  shapes: ReadonlyArray<readonly [string, Shape]>,
): Promise<ActiveHomeShapeReply | undefined> {
  try {
    const request = ask<ActiveHomeShapeReply>({
      op: 'active-home-shapes',
      handle,
      shapes: shapes.map(([key, shape]) => [key, shape]),
    });
    return request ? await request : undefined;
  } catch {
    return undefined;
  }
}

/** Materialize one bounded snapshot tranche when a route or action needs the ordinary mutable log. */
export async function hydrateActiveHomeInWorker<
  THeader = Record<string, unknown>,
  TEntry = unknown,
>(
  handle: number,
  cursor = 0,
  limit = 256,
): Promise<ActiveHomeHydrationChunk<THeader, TEntry> | undefined> {
  try {
    const request = ask<ActiveHomeHydrationChunk<THeader, TEntry>>({
      op: 'hydrate-active-home',
      handle,
      cursor,
      limit,
    });
    return request ? await request : undefined;
  } catch {
    return undefined;
  }
}

/** Abandon a compact open whose session was replaced before hydration. */
export async function releaseActiveHomeInWorker(handle: number): Promise<void> {
  try {
    await ask<boolean>({ op: 'release-active-home', handle });
  } catch {
    // A stopped/expired Worker already released it.
  }
}

/**
 * Open one encrypted vault value away from the page thread. The non-extractable key is only cloned, never exported.
 * A `projectAt` snapshot returns its first row projection in the same reply graph when possible.
 */
export async function openKeptInWorker<T>(
  key: CryptoKey,
  name: string,
  bytes: Uint8Array,
  retainRows = false,
  projectAt?: number,
): Promise<T | undefined> {
  // IndexedDB returns an owned clone, but Vault's test and alternate implementations need not. Transfer a copy so
  // moving the buffer into the Worker cannot detach the value they retain.
  const copy = bytes.slice();
  const request = ask<OpenedValue<T>>(
    { op: 'open', key, name, bytes: copy.buffer, retainRows, projectAt },
    [copy.buffer],
  );
  if (!request) return undefined;
  try {
    const { opened, retainedId, projected } = await request;
    projected?.source.forEach((row, index) =>
      openedProjections.set(row, { projection: projected, index }),
    );
    if (retainedId !== undefined && opened && typeof opened === 'object') {
      const entries = (opened as { entries?: unknown }).entries;
      if (Array.isArray(entries))
        entries.forEach((entry, index) => {
          const row = Array.isArray(entry) ? entry[2] : undefined;
          if (row && typeof row === 'object') retainedRows.set(row, { id: retainedId, index });
        });
    }
    return opened;
  } catch {
    return undefined;
  }
}

function openedProjection(source: Row[]): OpenedProjection | undefined {
  const first = source[0];
  if (!first) return undefined;
  const held = openedProjections.get(first);
  if (
    !held ||
    held.index !== 0 ||
    held.projection.source.length !== source.length ||
    held.projection.source.some((row, index) => row !== source[index])
  )
    return undefined;
  return held.projection;
}

function retainedProjection(
  source: Row[],
): { retainedId: number; indexes: Uint32Array } | { releaseRetained: number[] } {
  let retainedId: number | undefined;
  let complete = source.length > 0;
  const indexes = new Uint32Array(source.length);
  const seen = new Set<number>();
  source.forEach((row, index) => {
    const retained = retainedRows.get(row);
    if (!retained) {
      complete = false;
      return;
    }
    seen.add(retained.id);
    if (retainedId === undefined) retainedId = retained.id;
    else if (retainedId !== retained.id) complete = false;
    indexes[index] = retained.index;
  });
  return complete && retainedId !== undefined
    ? { retainedId, indexes }
    : { releaseRetained: [...seen] };
}

/** Project v4 documents and summarize stamps off-thread. Undefined asks the caller to use its sliced fallback. */
export async function projectRowsInWorker(
  source: Row[],
  now: number,
): Promise<ProjectedRows | undefined> {
  try {
    const opened = openedProjection(source);
    if (opened) {
      projectedLibraries.set(opened.rows, opened.library);
      if (HOME_VIEW_PROOF && opened.homeView) projectedHomeViews.set(opened.rows, opened.homeView);
      return opened;
    }
    const retained = retainedProjection(source);
    const message =
      'retainedId' in retained
        ? {
            op: 'project',
            retainedId: retained.retainedId,
            indexes: retained.indexes.buffer,
            now,
          }
        : { op: 'project', source, releaseRetained: retained.releaseRetained, now };
    const transfer = 'retainedId' in retained ? [retained.indexes.buffer] : [];
    const request = ask<ProjectedLibrary>(message, transfer);
    if (!request) return undefined;
    const projected = await request;
    projectedLibraries.set(projected.rows, projected.library);
    if (HOME_VIEW_PROOF && projected.homeView)
      projectedHomeViews.set(projected.rows, projected.homeView);
    return projected;
  } catch {
    return undefined;
  }
}

/** The Worker's development proof for this exact structured-cloned row array, when it supplied one. */
export function devHomeLibraryView(rows: Row[]): HomeLibraryViewProof | undefined {
  return HOME_VIEW_PROOF ? projectedHomeViews.get(rows) : undefined;
}

/** Fold already-projected rows through den-core off-thread. Undefined asks for the existing sliced fallback. */
export async function applyRowsInWorker(
  library: Library,
  rows: Row[],
): Promise<Library | undefined> {
  const projected = projectedLibraries.get(rows);
  if (
    projected &&
    library.records.length === 0 &&
    library.marks.length === 0 &&
    (library.flags?.size ?? 0) === 0 &&
    library.shapes.size === 0 &&
    library.dismissed.size === 0
  ) {
    projectedLibraries.delete(rows);
    // Deserialising the combined reply and publishing the whole reactive library must not become one task.
    await yieldTask();
    return projected;
  }
  try {
    const request = ask<Library>({ op: 'apply', library, rows });
    return request ? await request : undefined;
  } catch {
    return undefined;
  }
}
