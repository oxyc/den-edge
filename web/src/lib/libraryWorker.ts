// Cached-library opening, projection and the first policy fold are CPU-heavy on a large history. Keep them in one
// Worker so its den-core instance is reused; projection and fold share one reply instead of cloning rows twice.

import { applyLog, emptyLibrary } from './library';
import {
  activeHomeView,
  continueWithShapes,
  proveHomeLibraryView,
  selectActiveHomeSettings,
  selectHomeLibraryView,
  type ActiveHomePayload,
  type HomeLibraryView,
} from './homeLibraryView';
import type { Shape } from './library';
import { projectDocument } from './libraryV4';
import {
  compareStamps,
  isDocument,
  newestSummary,
  wellFormed,
  ZERO_STAMP,
  type Row,
  type Stamp,
} from './wire';
import { initialize } from '../vendor/den-core/index.js';

type Request =
  | {
      id: number;
      op: 'open';
      key: CryptoKey;
      name: string;
      bytes: ArrayBuffer;
      retainRows: boolean;
      projectAt?: number;
    }
  | {
      id: number;
      op: 'open-active-home';
      key: CryptoKey;
      name: string;
      bytes: ArrayBuffer;
      now: number;
    }
  | {
      id: number;
      op: 'active-home-shapes';
      handle: number;
      shapes: Array<[string, Shape]>;
    }
  | { id: number; op: 'hydrate-active-home'; handle: number; cursor: number; limit: number }
  | { id: number; op: 'release-active-home'; handle: number }
  | {
      id: number;
      op: 'project';
      source?: Row[];
      retainedId?: number;
      indexes?: ArrayBuffer;
      releaseRetained?: number[];
      now: number;
    }
  | {
      id: number;
      op: 'apply';
      library: Parameters<typeof applyLog>[0];
      rows: Row[];
    };

const utf8 = new TextEncoder();
const HOME_VIEW_PROOF = import.meta.env.DEV && import.meta.env.VITE_HOME_VIEW_PROOF === '1';
// A cached snapshot and its first projection normally cross in one clone graph, so unchanged row objects are copied
// once. If that projection fails, keep the Worker-side parse just long enough for the retry to refer to the immutable
// rows by tiny integer indexes instead of cloning the whole history back. The cap also bounds abandoned opens.
const retainedRows = new Map<number, unknown[]>();
let nextRetainedId = 0;
const RETAINED_LIMIT = 4;
const activeHomes = new Map<number, { opened: unknown; view: HomeLibraryView }>();

function retainActiveHome(opened: unknown, view: HomeLibraryView): number {
  const handle = ++nextRetainedId;
  activeHomes.set(handle, { opened, view });
  while (activeHomes.size > RETAINED_LIMIT) activeHomes.delete(activeHomes.keys().next().value!);
  return handle;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function openValue(key: CryptoKey, name: string, buffer: ArrayBuffer): Promise<unknown> {
  const bytes = new Uint8Array(buffer);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: utf8.encode(name) },
    key,
    bytes.subarray(12),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

function retainOpenedRows(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  const rows = entries.map((entry) => (Array.isArray(entry) ? entry[2] : undefined));
  const retainedId = ++nextRetainedId;
  retainedRows.set(retainedId, rows);
  while (retainedRows.size > RETAINED_LIMIT) retainedRows.delete(retainedRows.keys().next().value!);
  return retainedId;
}

function openedRows(value: unknown): Row[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  return entries.flatMap((entry) => {
    const row = Array.isArray(entry) ? entry[2] : undefined;
    return row && typeof row === 'object' && wellFormed(row as Row) ? [row as Row] : [];
  });
}

function retainedSource(retainedId: number, buffer: ArrayBuffer): Row[] {
  const held = retainedRows.get(retainedId);
  retainedRows.delete(retainedId);
  if (!held) throw new Error('retained library rows expired');
  return [...new Uint32Array(buffer)].map((index) => {
    const row = held[index];
    if (!row || typeof row !== 'object') throw new Error('retained library row is unavailable');
    return row as Row;
  });
}

async function project(source: Row[], now: number) {
  await initialize();
  const rows: Row[] = [];
  let stamp: Stamp = ZERO_STAMP;
  let reconsiderAt = Infinity;
  for (const row of source) {
    rows.push(...(isDocument(row) ? projectDocument(row) : [row]));
    const summary = newestSummary(row, now);
    if (compareStamps(summary.stamp, stamp) > 0) stamp = summary.stamp;
    reconsiderAt = Math.min(reconsiderAt, summary.reconsiderAt ?? Infinity);
  }
  return { rows, stamp, reconsiderAt, at: now };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    let value: unknown;
    if (request.op === 'open-active-home') {
      const opened = await openValue(request.key, request.name, request.bytes);
      const source = openedRows(opened);
      if (!source) throw new Error('kept library has no rows');
      const projection = await project(source, request.now);
      const library = applyLog(emptyLibrary(), projection.rows);
      const view = selectHomeLibraryView(library, projection.rows);
      const handle = retainActiveHome(opened, view);
      const payload: ActiveHomePayload = {
        handle,
        view: activeHomeView(view),
        settings: selectActiveHomeSettings(projection.rows),
        stamp: projection.stamp,
        reconsiderAt: projection.reconsiderAt,
        at: projection.at,
      };
      value = payload;
    } else if (request.op === 'active-home-shapes') {
      const active = activeHomes.get(request.handle);
      if (!active) throw new Error('active Home library expired');
      value = {
        handle: request.handle,
        continue: continueWithShapes(active.view, request.shapes),
      };
    } else if (request.op === 'hydrate-active-home') {
      const active = activeHomes.get(request.handle);
      if (!active) throw new Error('active Home library expired');
      if (!active.opened || typeof active.opened !== 'object')
        throw new Error('active Home library snapshot is unavailable');
      const snapshot = active.opened as Record<string, unknown> & { entries?: unknown };
      if (!Array.isArray(snapshot.entries))
        throw new Error('active Home library snapshot has no entries');
      const cursor = Math.max(0, Math.min(request.cursor, snapshot.entries.length));
      const limit = Math.max(1, Math.min(request.limit, 512));
      const entries = snapshot.entries.slice(cursor, cursor + limit);
      const next = cursor + entries.length;
      const done = next >= snapshot.entries.length;
      const { entries: _entries, ...header } = snapshot;
      value = {
        handle: request.handle,
        ...(cursor === 0 ? { header } : {}),
        entries,
        next,
        done,
      };
      if (done) activeHomes.delete(request.handle);
    } else if (request.op === 'release-active-home') {
      activeHomes.delete(request.handle);
      value = true;
    } else if (request.op === 'open') {
      const opened = await openValue(request.key, request.name, request.bytes);
      let projected:
        | (Awaited<ReturnType<typeof project>> & {
            source: Row[];
            library: ReturnType<typeof emptyLibrary>;
            homeView?: ReturnType<typeof proveHomeLibraryView>;
          })
        | undefined;
      if (request.projectAt !== undefined) {
        const source = openedRows(opened);
        if (source)
          try {
            const projection = await project(source, request.projectAt);
            const library = applyLog(emptyLibrary(), projection.rows);
            projected = {
              source,
              ...projection,
              library,
              ...(HOME_VIEW_PROOF
                ? { homeView: proveHomeLibraryView(library, projection.rows) }
                : {}),
            };
          } catch {
            // Opening the authoritative snapshot still succeeds. The page retries projection through the ordinary
            // retained/source path, whose sliced fallback remains available if the Worker itself is unavailable.
          }
      }
      value = {
        opened,
        projected,
        retainedId: request.retainRows && !projected ? retainOpenedRows(opened) : undefined,
      };
    } else if (request.op === 'project') {
      for (const retainedId of request.releaseRetained ?? []) retainedRows.delete(retainedId);
      const source =
        request.retainedId !== undefined && request.indexes
          ? retainedSource(request.retainedId, request.indexes)
          : request.source;
      if (!source) throw new Error('library projection has no rows');
      const projected = await project(source, request.now);
      const library = applyLog(emptyLibrary(), projected.rows);
      value = {
        ...projected,
        library,
        ...(HOME_VIEW_PROOF ? { homeView: proveHomeLibraryView(library, projected.rows) } : {}),
      };
    } else {
      await initialize();
      value = applyLog(request.library, request.rows);
    }
    self.postMessage({ id: request.id, value });
  } catch (error) {
    self.postMessage({ id: request.id, error: message(error) });
  }
};
