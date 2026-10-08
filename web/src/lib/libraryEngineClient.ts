// Page-side owner of one dedicated staged-open Worker. No singleton is shared with projection: a retained live log
// belongs to exactly one startup and is terminated when that startup hydrates or releases it.

import type { ActiveHomePayload, ActiveHomeShapeReply } from './homeLibraryView';
import type { Shape } from './library';
import type { LibraryEngineHydrationChunk, LibraryEngineReply } from './libraryEngine';
import { LibraryLog, type LibraryLogSnapshotEntry, type LibraryLogSnapshotHeader } from './log';
import { useLibraryCredential } from './relayFetch';
import { deriveKeys } from './wire';

type Waiting = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

function failed(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class EngineConnection {
  private nextId = 0;
  private readonly waiting = new Map<number, Waiting>();
  private stopped = false;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<LibraryEngineReply>) => {
      const pending = this.waiting.get(event.data.id);
      if (!pending) return;
      this.waiting.delete(event.data.id);
      if (event.data.error !== undefined) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.value);
    };
    worker.onerror = (event) => this.stop(event.error ?? event.message);
    worker.onmessageerror = () => this.stop(new Error('library engine reply could not be read'));
  }

  request<T>(message: Record<string, unknown>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('library engine has stopped'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, ...message });
      } catch (error) {
        this.waiting.delete(id);
        reject(failed(error));
      }
    });
  }

  stop(error = new Error('library engine released')): void {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }
}

interface ActiveConnection {
  connection: EngineConnection;
  remoteHandle: number;
}

export interface OpenedLibraryEngine {
  payload: ActiveHomePayload;
  hydrate(): Promise<LibraryLog | null>;
  release(): Promise<void>;
}

let nextHandle = 0;
const active = new Map<number, ActiveConnection>();

function startWorker(): Worker | undefined {
  // `Worker` also exists inside a Worker. Requiring a document makes this a page-only boundary and prevents this
  // client (or a future indirect import of it) from spawning a nested compute/startup Worker.
  if (typeof document === 'undefined' || typeof Worker === 'undefined') return undefined;
  try {
    return new Worker(new URL('./libraryEngineWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return undefined;
  }
}

/**
 * Open a library in a dedicated Worker and return its compact Home payload. The exact live log stays in the Worker
 * until `hydrate`; abandoning the startup calls `release`.
 */
export async function openLibraryEngine(key: string): Promise<OpenedLibraryEngine | undefined> {
  const worker = startWorker();
  if (!worker) return undefined;
  const connection = new EngineConnection(worker);
  try {
    const opened = await connection.request<ActiveHomePayload | undefined>({
      op: 'open',
      key,
      now: Date.now(),
    });
    if (!opened) {
      connection.stop();
      return undefined;
    }
    // The Worker's relay credential is module-local to that global. First-paint provider calls run on the page
    // before hydration, so install the same paired-library proof here as soon as the Worker has opened it.
    const raw = Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
    useLibraryCredential(await deriveKeys(raw));
    const handle = ++nextHandle;
    const payload = { ...opened, handle };
    active.set(handle, { connection, remoteHandle: opened.handle });
    let hydration: Promise<LibraryLog | null> | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      active.delete(handle);
      try {
        await connection.request<boolean>({ op: 'release', handle: opened.handle });
      } catch {
        // A failed/stopped Worker has already released its in-memory log.
      } finally {
        connection.stop();
      }
    };
    const hydrate = () =>
      (hydration ??= (async () => {
        const entries: LibraryLogSnapshotEntry[] = [];
        let header: LibraryLogSnapshotHeader | undefined;
        let cursor = 0;
        try {
          for (;;) {
            const chunk = await connection.request<LibraryEngineHydrationChunk>({
              op: 'hydrate',
              handle: opened.handle,
              cursor,
              limit: 256,
            });
            if (chunk.entries.length > 256 || chunk.next < cursor)
              throw new Error('library engine returned an invalid hydration chunk');
            header ??= chunk.header;
            entries.push(...chunk.entries);
            if (chunk.done) break;
            if (chunk.next === cursor) throw new Error('library engine hydration did not advance');
            cursor = chunk.next;
          }
          if (!header) throw new Error('library engine hydration omitted its header');
          return await LibraryLog.importSnapshot(key, { header, entries });
        } catch {
          return null;
        } finally {
          released = true;
          active.delete(handle);
          connection.stop();
        }
      })());
    return { payload, hydrate, release };
  } catch {
    connection.stop();
    return undefined;
  }
}

/** Recompute exact Continue candidates after the required TV layouts arrive. */
export async function projectLibraryEngineShapes(
  handle: number,
  shapes: ReadonlyArray<readonly [string, Shape]>,
): Promise<ActiveHomeShapeReply | undefined> {
  const held = active.get(handle);
  if (!held) return undefined;
  try {
    const reply = await held.connection.request<ActiveHomeShapeReply>({
      op: 'shapes',
      handle: held.remoteHandle,
      shapes: shapes.map(([key, shape]) => [key, shape]),
    });
    return { ...reply, handle };
  } catch {
    return undefined;
  }
}
