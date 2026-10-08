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
