import { expect, it, vi } from 'vitest';
import { createWorkerServiceConnection, createWorkerServiceSession } from './libraryServiceFactory';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import {
  CONTENT_SERVICE_PROTOCOL,
  type ContentServiceClientMessage,
  type ContentServiceServerMessage,
} from './contentServiceProtocol';
import { hasLibraryCredential } from './relayFetch';

type WorkerClientMessage = LibraryServiceClientMessage | ContentServiceClientMessage;
type WorkerServerMessage = LibraryServiceServerMessage | ContentServiceServerMessage;

class FakeWorker {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly posted: WorkerClientMessage[] = [];
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: WorkerClientMessage): void {
    this.posted.push(message);
  }

  emit(messages: WorkerServerMessage[]): void {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data: messages } as MessageEvent<unknown>);
  }

  fail(message = 'worker failed'): void {
    for (const listener of this.listeners.get('error') ?? [])
      listener({ message, preventDefault: () => {} } as unknown as ErrorEvent);
  }
}

const version = { instance: 'worker-1', generation: null, revision: 0 };
const openOptions = {
  libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  mode: 'online' as const,
  legacyClock: {
    device: '0123456789abcdef',
    last: [12, 3, '0123456789abcdef'] as [number, number, string],
  },
};

it('opens the library through its DedicatedWorker', async () => {
  const worker = new FakeWorker();
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const services = createWorkerServiceSession({
    createWorker,
    supervisor: { maxAutomaticRestarts: 0 },
  });

  const opening = services.library.open(openOptions);
  await expect.poll(() => worker.posted.length).toBe(1);
  const request = worker.posted[0] as LibraryServiceClientMessage;
  expect(request).toMatchObject({ type: 'hello', ...openOptions });
  worker.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: request.requestId,
      relayMembership: null,
      version,
    },
  ]);

  await expect(opening).resolves.toEqual(version);
  expect(createWorker).toHaveBeenCalledOnce();
  services.close();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('surfaces replacement Worker construction failure through the shared library status', async () => {
  const worker = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(worker as unknown as Worker)
    .mockImplementationOnce(() => {
      throw new Error('worker construction failed');
    });
  const services = createWorkerServiceSession({ createWorker });
  const statuses: unknown[] = [];
  services.library.onStatus((status) => statuses.push(status));

  const opening = services.library.open(openOptions);
  const hello = worker.posted[0];
  if (hello?.type !== 'hello') throw new Error('library hello was not sent');
  worker.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: hello.requestId,
      relayMembership: null,
      version,
    },
  ]);
  await opening;
  worker.fail();

  await expect
    .poll(() => statuses.at(-1))
    .toMatchObject({
      kind: 'failed',
      error: { code: 'unavailable', message: 'worker construction failed', retryable: true },
    });
  services.close();
});

it('bounds a silent startup and Retry replaces the expired Worker', async () => {
  vi.useFakeTimers();
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({
    createWorker,
    startupTimeoutMs: 20,
    supervisor: { maxAutomaticRestarts: 0 },
  });

  const opening = services.library.open(openOptions);
  const failed = expect(opening).rejects.toMatchObject({
    failure: {
      code: 'unavailable',
      message: 'Library service startup timed out while opening browser storage',
      retryable: true,
    },
  });
  await vi.advanceTimersByTimeAsync(20);
  await failed;
  expect(first.terminate).not.toHaveBeenCalled();

  const retrying = services.library.retry();
  expect(first.terminate).toHaveBeenCalledOnce();
  const request = replacement.posted[0] as LibraryServiceClientMessage;
  replacement.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: request.requestId,
      relayMembership: null,
      version: { ...version, instance: 'worker-2' },
    },
  ]);
  await expect(retrying).resolves.toMatchObject({ instance: 'worker-2' });
  expect(createWorker).toHaveBeenCalledTimes(2);
  services.close();
  expect(replacement.terminate).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it('starts public ContentService without opening encrypted library state', async () => {
  const worker = new FakeWorker();
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  expect(createWorker).toHaveBeenCalledOnce();
  const loading = services.content.query({ kind: 'service.regions' });
  const request = worker.posted[0];
  expect(request).toMatchObject({ type: 'content-query', request: { kind: 'service.regions' } });
  expect(worker.posted.some((message) => message.type === 'hello')).toBe(false);
  if (request?.type !== 'content-query') throw new Error('content query was not sent');
  worker.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: request.requestId,
      result: { kind: 'service.regions', regions: [] },
    },
  ]);
  await expect(loading).resolves.toEqual({ kind: 'service.regions', regions: [] });

  services.close();
  services.close();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('lets the physical connection exclusively own its shared Worker lifetime', () => {
  const worker = new FakeWorker();
  const connection = createWorkerServiceConnection(() => worker as unknown as Worker);

  connection.content.close();
  connection.library.close();
  expect(worker.terminate).not.toHaveBeenCalled();
  connection.close();
  connection.close();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('holds paired content traffic behind the library bootstrap barrier', async () => {
  const worker = new FakeWorker();
  const services = createWorkerServiceSession({
    createWorker: () => worker as unknown as Worker,
    supervisor: { maxAutomaticRestarts: 0 },
  });

  const opening = services.library.open(openOptions);
  const loading = services.content.query({ kind: 'service.regions' });
  expect(worker.posted).toHaveLength(1);
  const hello = worker.posted[0];
  if (hello?.type !== 'hello') throw new Error('library hello was not sent first');
  worker.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: hello.requestId,
      relayMembership: null,
      version,
    },
  ]);
  await opening;
  await expect.poll(() => worker.posted.length).toBe(2);
  const query = worker.posted[1];
  if (query?.type !== 'content-query') throw new Error('content query did not follow bootstrap');
  worker.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: query.requestId,
      result: { kind: 'service.regions', regions: [] },
    },
  ]);
  await expect(loading).resolves.toMatchObject({ kind: 'service.regions' });
  services.close();
});

it('follows a replacement bootstrap when the initial paired Worker fails while content waits', async () => {
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const configuring = services.content.query({ kind: 'sources.configure', atlas: '/atlas' });
  const initialConfiguration = first.posted[0];
  if (initialConfiguration?.type !== 'content-query')
    throw new Error('initial source configuration was not sent');
  first.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: initialConfiguration.requestId,
      result: { kind: 'sources.configure' },
    },
  ]);
  await configuring;

  const opening = services.library.open(openOptions);
  const firstHello = first.posted[1];
  if (firstHello?.type !== 'hello') throw new Error('initial hello was not sent');
  const loading = services.content.query({ kind: 'atlas.service.catalogs' });
  expect(first.posted).toHaveLength(2);
  first.fail();

  await expect.poll(() => replacement.posted.length).toBe(1);
  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello')
    throw new Error('replacement must begin with the paired hello');
  await Promise.resolve();
  await Promise.resolve();
  expect(replacement.posted).toEqual([replacementHello]);

  replacement.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: replacementHello.requestId,
      relayMembership: null,
      version: { ...version, instance: 'worker-2' },
    },
  ]);
  await opening;
  await expect.poll(() => replacement.posted.length).toBe(2);
  const replay = replacement.posted[1];
  expect(replay).toMatchObject({
    type: 'content-query',
    request: { kind: 'sources.configure', atlas: '/atlas' },
  });
  if (replay?.type !== 'content-query') throw new Error('source configuration was not replayed');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: replay.requestId,
      result: { kind: 'sources.configure' },
    },
  ]);

  await expect.poll(() => replacement.posted.length).toBe(3);
  const query = replacement.posted[2];
  expect(query).toMatchObject({
    type: 'content-query',
    request: { kind: 'atlas.service.catalogs' },
  });
  if (query?.type !== 'content-query') throw new Error('content query was not retried');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: query.requestId,
      result: { kind: 'atlas.service.catalogs', catalogs: { state: 'ready', value: [] } },
    },
  ]);
  await expect(loading).resolves.toMatchObject({ kind: 'atlas.service.catalogs' });
  services.close();
});

it('restores the bootstrap barrier when a paired Worker is replaced', async () => {
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const opening = services.library.open(openOptions);
  const firstHello = first.posted[0];
  if (firstHello?.type !== 'hello') throw new Error('initial hello was not sent');
  first.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: firstHello.requestId,
      relayMembership: null,
      version,
    },
  ]);
  await opening;
  first.fail();

  const loading = services.content.query({ kind: 'service.regions' });
  await expect.poll(() => replacement.posted.length).toBe(1);
  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello')
    throw new Error('replacement must reopen the library before content');
  replacement.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: replacementHello.requestId,
      relayMembership: null,
      version: { ...version, instance: 'worker-2' },
    },
  ]);
  await expect.poll(() => replacement.posted.length).toBe(2);
  const query = replacement.posted[1];
  if (query?.type !== 'content-query') throw new Error('content did not resume after bootstrap');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: query.requestId,
      result: { kind: 'service.regions', regions: [] },
    },
  ]);
  await expect(loading).resolves.toMatchObject({ kind: 'service.regions' });
  services.close();
});

it('retries paired in-flight content only after replacement bootstrap and source replay', async () => {
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const opening = services.library.open(openOptions);
  const firstHello = first.posted[0];
  if (firstHello?.type !== 'hello') throw new Error('initial hello was not sent');
  first.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: firstHello.requestId,
      relayMembership: null,
      version,
    },
  ]);
  await opening;

  const configuring = services.content.query({ kind: 'sources.configure', atlas: '/atlas' });
  await expect.poll(() => first.posted.length).toBe(2);
  const initialConfiguration = first.posted[1];
  if (initialConfiguration?.type !== 'content-query')
    throw new Error('initial source configuration was not sent');
  first.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: initialConfiguration.requestId,
      result: { kind: 'sources.configure' },
    },
  ]);
  await configuring;

  const loading = services.content.query({ kind: 'atlas.service.catalogs' });
  await expect.poll(() => first.posted.length).toBe(3);
  first.fail();

  await expect.poll(() => replacement.posted.length).toBe(1);
  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello')
    throw new Error('replacement must begin with the paired hello');
  // Let the rejected content request reach its retry turn: neither replay nor retry may pass the hello barrier.
  await Promise.resolve();
  await Promise.resolve();
  expect(replacement.posted).toEqual([replacementHello]);

  replacement.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: replacementHello.requestId,
      relayMembership: null,
      version: { ...version, instance: 'worker-2' },
    },
  ]);
  await expect.poll(() => replacement.posted.length).toBe(2);
  const replay = replacement.posted[1];
  expect(replay).toMatchObject({
    type: 'content-query',
    request: { kind: 'sources.configure', atlas: '/atlas' },
  });
  if (replay?.type !== 'content-query') throw new Error('source configuration was not replayed');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: replay.requestId,
      result: { kind: 'sources.configure' },
    },
  ]);

  await expect.poll(() => replacement.posted.length).toBe(3);
  const retried = replacement.posted[2];
  expect(retried).toMatchObject({
    type: 'content-query',
    request: { kind: 'atlas.service.catalogs' },
  });
  if (retried?.type !== 'content-query') throw new Error('content query was not retried');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: retried.requestId,
      result: { kind: 'atlas.service.catalogs', catalogs: { state: 'ready', value: [] } },
    },
  ]);
  await expect(loading).resolves.toMatchObject({ kind: 'atlas.service.catalogs' });
  services.close();
});

it('replays authoritative source configuration before retrying on a replacement Worker', async () => {
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const configuring = services.content.query({ kind: 'sources.configure', atlas: '/atlas/custom' });
  const configure = first.posted[0];
  if (configure?.type !== 'content-query') throw new Error('source configuration was not sent');
  first.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: configure.requestId,
      result: { kind: 'sources.configure' },
    },
  ]);
  await configuring;
  first.fail();

  const loading = services.content.query({
    kind: 'atlas.service.catalogs',
  });
  await expect.poll(() => replacement.posted.length).toBe(1);
  const replay = replacement.posted[0];
  expect(replay).toMatchObject({
    type: 'content-query',
    request: { kind: 'sources.configure', atlas: '/atlas/custom' },
  });
  if (replay?.type !== 'content-query') throw new Error('source configuration was not replayed');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: replay.requestId,
      result: { kind: 'sources.configure' },
    },
  ]);
  await expect.poll(() => replacement.posted.length).toBe(2);
  const query = replacement.posted[1];
  if (query?.type !== 'content-query') throw new Error('Atlas query was not retried');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: query.requestId,
      result: { kind: 'atlas.service.catalogs', catalogs: { state: 'ready', value: [] } },
    },
  ]);
  await expect(loading).resolves.toMatchObject({ kind: 'atlas.service.catalogs' });
  services.close();
});

it('opens a paired library on the public content Worker instead of creating a second one', async () => {
  const worker = new FakeWorker();
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const services = createWorkerServiceSession({
    createWorker,
    supervisor: { maxAutomaticRestarts: 0 },
  });

  const opening = services.library.open(openOptions);
  await expect.poll(() => worker.posted.some((message) => message.type === 'hello')).toBe(true);
  const request = worker.posted.find(
    (message): message is LibraryServiceClientMessage => message.type === 'hello',
  )!;
  const relayMembership = {
    libraryId: '50724b489a92805f23be6bba897393c7',
    memberToken: 'a17b6bb5b7e47d81e1fc40e34fe289274301987448de937c7ad2f566094fdf50',
  };
  worker.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: request.requestId,
      relayMembership,
      version,
    },
  ]);

  await expect(opening).resolves.toEqual(version);
  expect(hasLibraryCredential()).toBe(true);
  expect(createWorker).toHaveBeenCalledOnce();
  services.close();
  expect(hasLibraryCredential()).toBe(false);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
