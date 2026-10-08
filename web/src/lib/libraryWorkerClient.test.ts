import { afterEach, expect, it, vi } from 'vitest';
import type { Library } from './library';
import type { Row } from './wire';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('does not spawn a projection Worker from a Worker global', async () => {
  const Worker = vi.fn();
  vi.stubGlobal('Worker', Worker);
  vi.stubGlobal('document', undefined);
  const { projectRowsInWorker } = await import('./libraryWorkerClient');

  await expect(projectRowsInWorker([], 0)).resolves.toBeUndefined();
  expect(Worker).not.toHaveBeenCalled();
});

it('reuses the fold returned with projected rows instead of posting the whole history again', async () => {
  const rows: Row[] = [];
  const library: Library = {
    records: [],
    marks: [],
    flags: new Map(),
    shapes: new Map(),
    dismissed: new Map(),
  };
  const sent: Array<Record<string, unknown>> = [];

  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: (event: ErrorEvent) => void;
    onmessageerror?: () => void;

    postMessage(message: Record<string, unknown>): void {
      sent.push(message);
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            id: message.id,
            value: { rows, library, stamp: [0, 0, ''], reconsiderAt: Infinity, at: 0 },
          },
        } as MessageEvent),
      );
    }

    terminate(): void {}
  }

  vi.stubGlobal('document', {});
  vi.stubGlobal('Worker', FakeWorker);
  const { applyRowsInWorker, projectRowsInWorker } = await import('./libraryWorkerClient');
  const projected = await projectRowsInWorker([], 0);
  const folded = await applyRowsInWorker(
    { records: [], marks: [], flags: new Map(), shapes: new Map(), dismissed: new Map() },
    projected!.rows,
  );

  expect(folded).toBe(library);
  expect(sent.map(({ op }) => op)).toEqual(['project']);
});

it('opens and projects a kept snapshot in one reply without cloning its rows twice', async () => {
  const first = { kind: 'set', schema: 3, name: 'one', value: {} } as unknown as Row;
  const second = { kind: 'set', schema: 3, name: 'two', value: {} } as unknown as Row;
  const library: Library = {
    records: [],
    marks: [],
    flags: new Map(),
    shapes: new Map(),
    dismissed: new Map(),
  };
  const sent: Array<Record<string, unknown>> = [];

  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: (event: ErrorEvent) => void;
    onmessageerror?: () => void;

    postMessage(message: Record<string, unknown>): void {
      sent.push(message);
      const value =
        message.op === 'open'
          ? {
              opened: {
                entries: [
                  ['two', 2, second],
                  ['one', 1, first],
                ],
              },
              projected: {
                source: [second, first],
                rows: [second, first],
                library,
                stamp: [0, 0, ''],
                reconsiderAt: Infinity,
                at: 123,
              },
            }
          : {
              rows: [first, second],
              library,
              stamp: [0, 0, ''],
              reconsiderAt: Infinity,
              at: 123,
            };
      const reply = structuredClone({ id: message.id, value });
      queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
    }

    terminate(): void {}
  }

  vi.stubGlobal('document', {});
  vi.stubGlobal('Worker', FakeWorker);
  const { applyRowsInWorker, openKeptInWorker, projectRowsInWorker } =
    await import('./libraryWorkerClient');
  const opened = await openKeptInWorker<{ entries: [string, number, Row][] }>(
    {} as CryptoKey,
    'log.v4',
    new Uint8Array(),
    true,
    123,
  );
  const projected = await projectRowsInWorker(
    [opened!.entries[0]![2], opened!.entries[1]![2]],
    123,
  );
  const folded = await applyRowsInWorker(
    { records: [], marks: [], flags: new Map(), shapes: new Map(), dismissed: new Map() },
    projected!.rows,
  );

  expect(folded).toStrictEqual(library);
  expect(projected!.rows[0]).toBe(opened!.entries[0]![2]);
  expect(projected!.rows[1]).toBe(opened!.entries[1]![2]);
  expect(sent.map(({ op }) => op)).toEqual(['open']);
  expect(sent[0]?.projectAt).toBe(123);
});

it('does not reuse the opened projection after the authoritative row order changes', async () => {
  const first = { kind: 'set', schema: 3, name: 'one', value: {} } as unknown as Row;
  const second = { kind: 'set', schema: 3, name: 'two', value: {} } as unknown as Row;
  const library: Library = {
    records: [],
    marks: [],
    flags: new Map(),
    shapes: new Map(),
    dismissed: new Map(),
  };
  const sent: Array<Record<string, unknown>> = [];

  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: (event: ErrorEvent) => void;
    onmessageerror?: () => void;

    postMessage(message: Record<string, unknown>): void {
      sent.push(message);
      const source = message.op === 'open' ? [first, second] : (message.source as Row[]);
      const value =
        message.op === 'open'
          ? {
              opened: {
                entries: [
                  ['one', 1, first],
                  ['two', 2, second],
                ],
              },
              projected: {
                source,
                rows: source,
                library,
                stamp: [0, 0, ''],
                reconsiderAt: Infinity,
                at: 123,
              },
            }
          : {
              rows: source,
              library,
              stamp: [0, 0, ''],
              reconsiderAt: Infinity,
              at: 124,
            };
      const reply = structuredClone({ id: message.id, value });
      queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
    }

    terminate(): void {}
  }

  vi.stubGlobal('document', {});
  vi.stubGlobal('Worker', FakeWorker);
  const { openKeptInWorker, projectRowsInWorker } = await import('./libraryWorkerClient');
  const opened = await openKeptInWorker<{ entries: [string, number, Row][] }>(
    {} as CryptoKey,
    'log.v4',
    new Uint8Array(),
    true,
    123,
  );
  const reordered = [opened!.entries[1]![2], opened!.entries[0]![2]];
  const projected = await projectRowsInWorker(reordered, 124);

  expect(sent.map(({ op }) => op)).toEqual(['open', 'project']);
  expect(sent[1]?.source).toEqual(reordered);
  expect(projected?.rows).toStrictEqual(reordered);
  expect(projected?.at).toBe(124);
});

it('opens Home compactly, projects late shapes, and hydrates the retained snapshot in bounded chunks', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const compact = {
    handle: 7,
    view: {
      owned: ['tv:1'],
      watched: [],
      watchlist: [],
      standings: [['tv:1', 'inProgress']],
      weighted: [['tv:1', 1, 10]],
      seeds: { watched: ['tv:1'], watchlisted: [] },
      shelfRefs: ['tv:1'],
      requiredShapeRefs: ['tv:1'],
      continue: [],
      downloads: [],
    },
    settings: {
      tmdbKey: 'key',
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
    stamp: [10, 0, 'tv'],
    reconsiderAt: Infinity,
    at: 10,
  };

  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: (event: ErrorEvent) => void;
    onmessageerror?: () => void;

    postMessage(message: Record<string, unknown>): void {
      sent.push(message);
      const value =
        message.op === 'open-active-home'
          ? compact
          : message.op === 'active-home-shapes'
            ? {
                handle: 7,
                continue: [{ ref: { type: 'tv', id: 1 }, fraction: 0, display: 'record' }],
              }
            : message.cursor === 0
              ? { handle: 7, header: { head: 2 }, entries: [['one']], next: 1, done: false }
              : { handle: 7, entries: [['two']], next: 2, done: true };
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, value } } as MessageEvent));
    }

    terminate(): void {}
  }

  vi.stubGlobal('document', {});
  vi.stubGlobal('Worker', FakeWorker);
  const { hydrateActiveHomeInWorker, openActiveHomeInWorker, projectActiveHomeShapes } =
    await import('./libraryWorkerClient');
  const opened = await openActiveHomeInWorker(
    {} as CryptoKey,
    'log.v4',
    new Uint8Array([1, 2]),
    10,
  );
  const shaped = await projectActiveHomeShapes(7, [['tv:1', { counts: new Map([[1, 8]]) }]]);
  const first = await hydrateActiveHomeInWorker(7, 0, 1);
  const second = await hydrateActiveHomeInWorker(7, first!.next, 1);

  expect(opened).toEqual(compact);
  expect(opened).not.toHaveProperty('opened');
  expect(opened).not.toHaveProperty('source');
  expect(opened).not.toHaveProperty('rows');
  expect(opened).not.toHaveProperty('library');
  expect(opened?.view).not.toHaveProperty('continueLibrary');
  expect(shaped?.continue[0]?.ref).toEqual({ type: 'tv', id: 1 });
  expect(first).toMatchObject({ header: { head: 2 }, next: 1, done: false });
  expect(second).toMatchObject({ next: 2, done: true });
  expect(sent.map(({ op }) => op)).toEqual([
    'open-active-home',
    'active-home-shapes',
    'hydrate-active-home',
    'hydrate-active-home',
  ]);
  expect(sent[0]).not.toHaveProperty('opened');
  expect(sent[0]).not.toHaveProperty('source');
  expect(sent[0]).not.toHaveProperty('rows');
  expect(sent[0]).not.toHaveProperty('library');
});
