import { expect, it, vi } from 'vitest';
import type { LibraryServiceAuthority } from './libraryServiceCore';
import { createLibraryService } from './libraryServiceFactory';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';

class FakeWorker {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly posted: LibraryServiceClientMessage[] = [];
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: LibraryServiceClientMessage): void {
    this.posted.push(message);
  }

  emit(messages: LibraryServiceServerMessage[]): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: messages } as MessageEvent<unknown>);
  }
}

const version = { instance: 'worker-1', generation: null, revision: 0 };
const openOptions = {
  libraryKey: 'library-1',
  mode: 'online' as const,
  legacyClock: {
    device: '0123456789abcdef',
    last: [12, 3, '0123456789abcdef'] as [number, number, string],
  },
};

function emptyAuthority(close = vi.fn()): LibraryServiceAuthority {
  return {
    generation: null,
    async select(selection) {
      if (selection.kind !== 'title') throw new Error('selection not used by this test');
      return {
        kind: 'title',
        title: selection.title,
        listed: false,
        watched: false,
        reaction: null,
        standing: null,
        progress: null,
        episodes: [],
      };
    },
    async command() {
      return { outcome: 'unchanged', delivery: 'local', affected: [] };
    },
    async query() {
      throw new Error('query not used by this test');
    },
    async observe() {
      return { outcome: 'unchanged', affected: [] };
    },
    close,
  };
}

it('locks an available runtime to DedicatedWorker before open', async () => {
  const worker = new FakeWorker();
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const openAuthority = vi.fn(async () => emptyAuthority());
  const service = createLibraryService(
    { dedicatedWorker: true },
    { createWorker, openAuthority, supervisor: { maxAutomaticRestarts: 0 } },
  );

  const opening = service.open(openOptions);
  await expect.poll(() => worker.posted.length).toBe(1);
  const request = worker.posted[0]!;
  expect(request).toMatchObject({ type: 'hello', ...openOptions });
  worker.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: request.requestId,
      version,
    },
  ]);

  await expect(opening).resolves.toEqual(version);
  expect(createWorker).toHaveBeenCalledOnce();
  expect(openAuthority).not.toHaveBeenCalled();
  service.close();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('uses the same Core authority boundary when the explicit capability requires inline', async () => {
  const close = vi.fn();
  const authority = emptyAuthority(close);
  const openAuthority = vi.fn(async () => authority);
  const createWorker = vi.fn();
  const service = createLibraryService(
    { dedicatedWorker: false },
    { createWorker, openAuthority, supervisor: { maxAutomaticRestarts: 0 } },
  );

  await expect(service.open({ ...openOptions, mode: 'local' })).resolves.toMatchObject({
    generation: null,
    revision: 0,
  });
  expect(openAuthority).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'hello', ...openOptions, mode: 'local' }),
  );
  expect(createWorker).not.toHaveBeenCalled();

  service.close();
  await expect.poll(() => close.mock.calls.length).toBe(1);
});

it('never falls back to an inline authority when Worker construction fails', async () => {
  const openAuthority = vi.fn(async () => emptyAuthority());
  const service = createLibraryService(
    { dedicatedWorker: true },
    {
      createWorker: () => {
        throw new Error('worker construction failed');
      },
      openAuthority,
      supervisor: { maxAutomaticRestarts: 0 },
    },
  );

  await expect(service.open(openOptions)).rejects.toMatchObject({
    failure: { code: 'unavailable', message: 'worker construction failed', retryable: true },
  });
  expect(openAuthority).not.toHaveBeenCalled();
  service.close();
});
