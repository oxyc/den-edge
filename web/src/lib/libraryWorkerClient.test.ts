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
