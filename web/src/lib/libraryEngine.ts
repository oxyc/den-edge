// The staged-open state machine shared by its Worker entry point and focused protocol tests. The authoritative
// LibraryLog stays here until hydration completes; only compact Home inputs cross for first paint.

import {
  activeHomeView,
  continueWithShapes,
  selectActiveHomeSettings,
  selectHomeLibraryView,
  type ActiveHomeHydrationChunk,
  type ActiveHomePayload,
  type ActiveHomeShapeReply,
  type HomeLibraryView,
} from './homeLibraryView';
import { applyLog, emptyLibrary, type Library, type Shape } from './library';
import {
  LibraryLog,
  type LibraryLogSnapshot,
  type LibraryLogSnapshotEntry,
  type LibraryLogSnapshotHeader,
} from './log';

export const LIBRARY_ENGINE_CHUNK_MAX = 256;

export type LibraryEngineRequest =
  | { id: number; op: 'open'; key: string; now: number }
  | { id: number; op: 'kept'; handle: number; name: string }
  | { id: number; op: 'keep'; handle: number; name: string; value: unknown }
  | { id: number; op: 'shapes'; handle: number; shapes: Array<[string, Shape]> }
  | { id: number; op: 'hydrate'; handle: number; cursor: number; limit?: number }
  | { id: number; op: 'release'; handle: number };

export interface LibraryEngineReply {
  id: number;
  value?: unknown;
  error?: string;
}

export interface LibraryEngineProjection {
  rows: ReturnType<LibraryLog['rows']>;
  library: Library;
  /** Small exact policy input retained so late TV layouts never force a full page-thread Continue pass. */
  continueLibrary?: Library;
}

export type LibraryEngineHydrationChunk = ActiveHomeHydrationChunk<
  LibraryLogSnapshotHeader,
  LibraryLogSnapshotEntry
> & {
  /** The exact projection already folded for compact Home, returned only with the final snapshot chunk. */
  projection?: LibraryEngineProjection;
};

type OpenLog = (key: string) => Promise<LibraryLog | null>;

interface ActiveLibrary {
  log: LibraryLog;
  view: HomeLibraryView;
  projection: LibraryEngineProjection;
  snapshot?: LibraryLogSnapshot;
}

export class LibraryEngine {
  private nextHandle = 0;
  private readonly active = new Map<number, ActiveLibrary>();

  constructor(private readonly openLog: OpenLog = (key) => LibraryLog.open(key)) {}

  async request(request: LibraryEngineRequest): Promise<unknown> {
    if (request.op === 'open') return this.open(request.key, request.now);
    const held = this.active.get(request.handle);
    if (!held) throw new Error('staged library has expired');
    if (request.op === 'kept') return held.log.kept(request.name);
    if (request.op === 'keep') {
      await held.log.keep(request.name, request.value);
      return true;
    }
    if (request.op === 'shapes')
      return {
        handle: request.handle,
        continue: continueWithShapes(held.view, request.shapes),
      } satisfies ActiveHomeShapeReply;
    if (request.op === 'release') {
      this.active.delete(request.handle);
      return true;
    }
    const snapshot = (held.snapshot ??= held.log.exportSnapshot());
    const cursor = Math.max(0, Math.min(request.cursor, snapshot.entries.length));
    const limit = Math.max(
      1,
      Math.min(request.limit ?? LIBRARY_ENGINE_CHUNK_MAX, LIBRARY_ENGINE_CHUNK_MAX),
    );
    const entries = snapshot.entries.slice(cursor, cursor + limit);
    const next = cursor + entries.length;
    const done = next >= snapshot.entries.length;
    const chunk: LibraryEngineHydrationChunk = {
      handle: request.handle,
      ...(cursor === 0 ? { header: snapshot.header } : {}),
      entries,
      next,
      done,
      ...(done ? { projection: held.projection } : {}),
    };
    if (done) this.active.delete(request.handle);
    return chunk;
  }

  private async open(key: string, now: number): Promise<ActiveHomePayload | undefined> {
    const log = await this.openLog(key);
    if (!log) return undefined;
    // `rows()` is intentionally synchronous here. `LibraryLog.open` already initialized den-core, and calling
    // `rowsInSlices()` in a Worker would route through the page's compute-worker client and risk a nested Worker.
    const rows = log.rows();
    const library = applyLog(emptyLibrary(), rows);
    const view = selectHomeLibraryView(library, rows);
    const handle = ++this.nextHandle;
    this.active.set(handle, {
      log,
      view,
      projection: { rows, library, continueLibrary: view.continueLibrary },
    });
    const summary = log.currentSummary(now);
    return {
      handle,
      view: activeHomeView(view),
      settings: selectActiveHomeSettings(rows),
      stamp: summary.stamp,
      reconsiderAt: summary.reconsiderAt,
      at: summary.at,
    };
  }
}
