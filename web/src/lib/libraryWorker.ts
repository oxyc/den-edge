// Cached-library opening, projection and the first policy fold are CPU-heavy on a large history. Keep them in one
// Worker so its den-core instance is reused; projection and fold share one reply instead of cloning rows twice.

import { applyLog, emptyLibrary } from './library';
import { proveHomeLibraryView } from './homeLibraryView';
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
    if (request.op === 'open') {
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
