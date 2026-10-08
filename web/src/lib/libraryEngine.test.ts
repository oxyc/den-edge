import { afterEach, expect, it, vi } from 'vitest';
import type { ActiveHomePayload } from './homeLibraryView';
import {
  LIBRARY_ENGINE_CHUNK_MAX,
  LibraryEngine,
  type LibraryEngineHydrationChunk,
} from './libraryEngine';
import type { LibraryLog, LibraryLogSnapshot } from './log';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

function fakeSnapshot(size: number): LibraryLogSnapshot {
  return {
    header: {
      version: 1,
      head: size,
      memberRegistered: true,
      wireMin: 4,
      upgradeRequired: null,
      unreadable: [],
      newerFraming: [],
      newerDocuments: [],
      switchFailure: null,
      predatesV3: false,
      compactionRefused: null,
      moved: false,
      refused: false,
      refusedAt: 0,
      refusal: null,
      rejected: [],
      fromCache: true,
      generationChanges: 0,
      unreported: false,
    },
    entries: Array.from({ length: size }, (_, index) => ({ name: `row:${index}` })),
  };
}

it('opens and folds in the owning worker, accepts shapes, and exports at most 256 entries per chunk', async () => {
  const snapshot = fakeSnapshot(600);
  const rows = vi.fn(() => []);
  const rowsInSlices = vi.fn(() => {
    throw new Error('must not start a nested projection worker');
  });
  const keep = vi.fn(async () => {});
  const log = {
    rows,
    rowsInSlices,
    kept: vi.fn(async (name: string) => (name === 'billboard' ? ['retained'] : undefined)),
    keep,
    currentSummary: () => ({ stamp: [10, 0, 'tv'] as const, reconsiderAt: Infinity, at: 10 }),
    exportSnapshot: () => snapshot,
  } as unknown as LibraryLog;
  const engine = new LibraryEngine(async () => log);

  const payload = (await engine.request({
    id: 1,
    op: 'open',
    key: 'key',
    now: 10,
  })) as ActiveHomePayload;
  await expect(
    engine.request({ id: 2, op: 'kept', handle: payload.handle, name: 'billboard' }),
  ).resolves.toEqual(['retained']);
  await expect(
    engine.request({
      id: 3,
      op: 'keep',
      handle: payload.handle,
      name: 'billboard',
      value: ['new'],
    }),
  ).resolves.toBe(true);
  expect(keep).toHaveBeenCalledWith('billboard', ['new']);
  const shaped = await engine.request({ id: 4, op: 'shapes', handle: payload.handle, shapes: [] });
  const chunks = [];
  let cursor = 0;
  for (;;) {
    const chunk = (await engine.request({
      id: 5 + chunks.length,
      op: 'hydrate',
      handle: payload.handle,
      cursor,
      limit: 1_000,
    })) as LibraryEngineHydrationChunk;
    chunks.push(chunk);
    cursor = chunk.next;
    if (chunk.done) break;
  }

  expect(rows).toHaveBeenCalledOnce();
  expect(rowsInSlices).not.toHaveBeenCalled();
  expect(payload).not.toHaveProperty('rows');
  expect(payload.view).not.toHaveProperty('continueLibrary');
  expect(shaped).toMatchObject({ handle: payload.handle, continue: [] });
  expect(chunks.map(({ entries }) => entries.length)).toEqual([
    LIBRARY_ENGINE_CHUNK_MAX,
    LIBRARY_ENGINE_CHUNK_MAX,
    88,
  ]);
  expect(chunks[0]?.header).toEqual(snapshot.header);
  expect(chunks[1]).not.toHaveProperty('header');
  expect(chunks[0]).not.toHaveProperty('projection');
  expect(chunks[1]).not.toHaveProperty('projection');
  expect(chunks[2]?.projection).toMatchObject({
    rows: [],
    library: { records: [], marks: [] },
    continueLibrary: { records: [], marks: [] },
  });
  await expect(
    engine.request({ id: 9, op: 'shapes', handle: payload.handle, shapes: [] }),
  ).rejects.toThrow('expired');
});

it('does not construct an engine Worker outside a page', async () => {
  const Worker = vi.fn();
  vi.stubGlobal('Worker', Worker);
  vi.stubGlobal('document', undefined);

  const { openLibraryEngine } = await import('./libraryEngineClient');

  await expect(openLibraryEngine('key')).resolves.toBeUndefined();
  expect(Worker).not.toHaveBeenCalled();
});

it('assembles bounded chunks, imports once without reopening, and remaps shape handles', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const imported = { rows: () => [] } as unknown as LibraryLog;
  const { LibraryLog } = await import('./log');
  const importSnapshot = vi.spyOn(LibraryLog, 'importSnapshot').mockResolvedValue(imported);
  const header = fakeSnapshot(0).header;

  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: (event: ErrorEvent) => void;
    onmessageerror?: () => void;
    terminate = vi.fn();

    postMessage(message: Record<string, unknown>): void {
      sent.push(message);
      const value =
        message.op === 'open'
          ? {
              handle: 41,
              view: {
                owned: [],
                watched: [],
                watchlist: [],
                standings: [],
                weighted: [],
                seeds: { watched: [], watchlisted: [] },
                shelfRefs: [],
                requiredShapeRefs: [],
                continue: [],
                downloads: [],
              },
              settings: {
                tmdbKey: '',
                plugins: [],
                remux: null,
                prefs: {
                  excludedGenres: [],
                  excludedLanguages: [],
                  hideAnime: false,
                  hideWatched: false,
                  services: [],
                  servicesConfigured: false,
                },
              },
              stamp: [0, 0, ''],
              reconsiderAt: Infinity,
              at: 10,
            }
          : message.op === 'shapes'
            ? { handle: 41, continue: [] }
            : message.cursor === 0
              ? {
                  handle: 41,
                  header,
                  entries: fakeSnapshot(256).entries,
                  next: 256,
                  done: false,
                }
              : {
                  handle: 41,
                  entries: fakeSnapshot(2).entries,
                  next: 258,
                  done: true,
                  projection: {
                    rows: [],
                    library: {
                      records: [],
                      marks: [],
                      flags: new Map(),
                      shapes: new Map(),
                      dismissed: new Map(),
                    },
                  },
                };
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, value } } as MessageEvent));
    }
  }

  vi.stubGlobal('document', {});
  vi.stubGlobal('Worker', FakeWorker);
  const { openLibraryEngine, projectLibraryEngineShapes } = await import('./libraryEngineClient');
  const opened = await openLibraryEngine(btoa(String.fromCharCode(...new Uint8Array(32))));
  const shapes = await projectLibraryEngineShapes(opened!.payload.handle, []);
  const hydrated = await opened!.hydrate();

  expect(opened?.payload.handle).not.toBe(41);
  expect(shapes?.handle).toBe(opened?.payload.handle);
  expect(hydrated?.log).toBe(imported);
  expect(hydrated?.projection.rows).toEqual([]);
  expect(importSnapshot).toHaveBeenCalledOnce();
  expect(importSnapshot.mock.calls[0]?.[1].entries).toHaveLength(258);
  expect(sent.map(({ op }) => op)).toEqual(['open', 'shapes', 'hydrate', 'hydrate']);
  expect(sent.filter(({ op }) => op === 'hydrate').map(({ limit }) => limit)).toEqual([256, 256]);
});
