import type { Library } from './library';
import type { Row, Stamp } from './wire';

interface ProjectedRows {
  rows: Row[];
  stamp: Stamp;
  reconsiderAt: number;
}

interface WorkerReply {
  id: number;
  value?: unknown;
  error?: string;
}

type Waiting = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, Waiting>();

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

/** Open one encrypted vault value away from the page thread. The non-extractable key is only cloned, never exported. */
export async function openKeptInWorker<T>(
  key: CryptoKey,
  name: string,
  bytes: Uint8Array,
): Promise<T | undefined> {
  // IndexedDB returns an owned clone, but Vault's test and alternate implementations need not. Transfer a copy so
  // moving the buffer into the Worker cannot detach the value they retain.
  const copy = bytes.slice();
  const request = ask<T>({ op: 'open', key, name, bytes: copy.buffer }, [copy.buffer]);
  if (!request) return undefined;
  try {
    return await request;
  } catch {
    return undefined;
  }
}

/** Project v4 documents and summarize stamps off-thread. Undefined asks the caller to use its sliced fallback. */
export async function projectRowsInWorker(
  source: Row[],
  now: number,
): Promise<ProjectedRows | undefined> {
  try {
    const request = ask<ProjectedRows>({ op: 'project', source, now });
    return request ? await request : undefined;
  } catch {
    return undefined;
  }
}

/** Fold already-projected rows through den-core off-thread. Undefined asks for the existing sliced fallback. */
export async function applyRowsInWorker(
  library: Library,
  rows: Row[],
): Promise<Library | undefined> {
  try {
    const request = ask<Library>({ op: 'apply', library, rows });
    return request ? await request : undefined;
  } catch {
    return undefined;
  }
}
