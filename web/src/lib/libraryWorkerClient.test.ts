import { afterEach, expect, it, vi } from 'vitest';
import type { Library } from './library';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const empty = (): Library => ({
  records: [],
  marks: [],
  flags: new Map(),
  shapes: new Map(),
  dismissed: new Map(),
});

it('does not spawn a nested Worker from a Worker global', async () => {
  const Worker = vi.fn();
  vi.stubGlobal('Worker', Worker);
  vi.stubGlobal('document', undefined);
  const { applyRowsInWorker, openKeptInWorker } = await import('./libraryWorkerClient');

  await expect(applyRowsInWorker(empty(), [])).resolves.toBeUndefined();
  await expect(
    openKeptInWorker({} as CryptoKey, 'log.v4', new Uint8Array()),
  ).resolves.toBeUndefined();
  expect(Worker).not.toHaveBeenCalled();
});

it('opens a kept value and folds rows through the one page Worker', async () => {
  const library = empty();
  const sent: Array<Record<string, unknown>> = [];

  class FakeWorker {
    onmessage?: (event: MessageEvent) => void;
    onerror?: (event: ErrorEvent) => void;
    onmessageerror?: () => void;

    postMessage(message: Record<string, unknown>): void {
      sent.push(message);
      const value = message.op === 'open' ? { opened: { entries: [] } } : library;
      const reply = structuredClone({ id: message.id, value });
      queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
    }

    terminate(): void {}
  }

  vi.stubGlobal('document', {});
  vi.stubGlobal('Worker', FakeWorker);
  const { applyRowsInWorker, openKeptInWorker } = await import('./libraryWorkerClient');

  await expect(openKeptInWorker({} as CryptoKey, 'log.v4', new Uint8Array())).resolves.toEqual({
    entries: [],
  });
  await expect(applyRowsInWorker(empty(), [])).resolves.toStrictEqual(library);
  expect(sent.map(({ op }) => op)).toEqual(['open', 'apply']);
});
