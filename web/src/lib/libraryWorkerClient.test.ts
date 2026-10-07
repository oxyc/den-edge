import { afterEach, expect, it, vi } from 'vitest';
import type { Library } from './library';
import type { Row } from './wire';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
            value: { rows, library, stamp: [0, 0, ''], reconsiderAt: Infinity },
          },
        } as MessageEvent),
      );
    }

    terminate(): void {}
  }

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

it('projects rows retained from a kept snapshot without cloning them back to the worker', async () => {
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
              retainedId: 17,
            }
          : { rows: [first, second], library, stamp: [0, 0, ''], reconsiderAt: Infinity };
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, value } } as MessageEvent));
    }

    terminate(): void {}
  }

  vi.stubGlobal('Worker', FakeWorker);
  const { applyRowsInWorker, openKeptInWorker, projectRowsInWorker } =
    await import('./libraryWorkerClient');
  const opened = await openKeptInWorker<{ entries: [string, number, Row][] }>(
    {} as CryptoKey,
    'log.v4',
    new Uint8Array(),
    true,
  );
  const projected = await projectRowsInWorker([opened!.entries[1]![2], opened!.entries[0]![2]], 0);
  const folded = await applyRowsInWorker(
    { records: [], marks: [], flags: new Map(), shapes: new Map(), dismissed: new Map() },
    projected!.rows,
  );

  expect(folded).toBe(library);
  expect(sent.map(({ op }) => op)).toEqual(['open', 'project']);
  expect(sent[1]).not.toHaveProperty('source');
  expect(sent[1]?.retainedId).toBe(17);
  expect([...new Uint32Array(sent[1]?.indexes as ArrayBuffer)]).toEqual([1, 0]);
});
