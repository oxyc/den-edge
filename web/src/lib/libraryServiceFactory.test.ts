import { expect, it, vi } from 'vitest';
import { ContentServiceError } from './contentServiceClient';
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

it('leaves a terminal paired hello failure owned by explicit library retry', async () => {
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({
    createWorker,
    supervisor: { maxAutomaticRestarts: 0 },
  });

  const opening = services.library.open(openOptions);
  const failedOpen = expect(opening).rejects.toMatchObject({
    failure: { code: 'unavailable', retryable: true },
  });
  const loading = services.content.query({ kind: 'service.regions' });
  const failedContent = loading.catch((error: unknown) => error);
  expect(first.posted).toHaveLength(1);
  expect(first.posted[0]).toMatchObject({ type: 'hello' });
  first.fail();

  await failedOpen;
  const contentFailure = await failedContent;
  expect(contentFailure).toBeInstanceOf(ContentServiceError);
  expect(contentFailure).toMatchObject({
    failure: { code: 'unavailable', retryable: true },
    scope: 'transport',
  });
  expect(createWorker).toHaveBeenCalledOnce();
  expect(replacement.posted).toEqual([]);

  const retrying = services.library.retry();
  expect(createWorker).toHaveBeenCalledTimes(2);
  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello')
    throw new Error('explicit library retry did not own the replacement');
  replacement.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: replacementHello.requestId,
      relayMembership: null,
      version: { ...version, instance: 'worker-2' },
    },
  ]);
  await expect(retrying).resolves.toMatchObject({ instance: 'worker-2' });
  expect(replacement.posted).toEqual([replacementHello]);
  services.close();
});

it('cancels content waiting on paired hello without replacement or a later query', async () => {
  const first = new FakeWorker();
  const replacement = new FakeWorker();
  const createWorker = vi
    .fn<() => Worker>()
    .mockReturnValueOnce(first as unknown as Worker)
    .mockReturnValueOnce(replacement as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const opening = services.library.open(openOptions);
  const controller = new AbortController();
  const loading = services.content.query({ kind: 'service.regions' }, controller.signal);
  expect(first.posted).toHaveLength(1);
  expect(first.posted[0]).toMatchObject({ type: 'hello' });
  controller.abort();
  await expect(loading).rejects.toMatchObject({ failure: { code: 'cancelled' } });
  expect(createWorker).toHaveBeenCalledOnce();

  first.fail();
  await expect.poll(() => replacement.posted.length).toBe(1);
  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello') throw new Error('library replacement did not say hello');
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
  await Promise.resolve();
  await Promise.resolve();
  expect(replacement.posted).toEqual([replacementHello]);
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

it('lets the library supervisor replace a paired Worker after a detail transport failure', async () => {
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

  const loading = services.content.query({
    kind: 'title.detail',
    title: { type: 'tv', id: 213344 },
    region: 'US',
  });
  await expect.poll(() => first.posted.length).toBe(2);
  const firstDetail = first.posted[1];
  if (firstDetail?.type !== 'content-query') throw new Error('detail query was not sent');
  first.fail('content transport failed');

  await expect.poll(() => replacement.posted.length).toBe(1);
  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello')
    throw new Error('the library supervisor did not own the replacement');
  expect(createWorker).toHaveBeenCalledTimes(2);
  expect(first.terminate).toHaveBeenCalledOnce();
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
  const retriedDetail = replacement.posted[1];
  expect(retriedDetail).toMatchObject({
    type: 'content-query',
    request: {
      kind: 'title.detail',
      title: { type: 'tv', id: 213344 },
      region: 'US',
    },
  });
  if (retriedDetail?.type !== 'content-query') throw new Error('detail query was not retried');
  replacement.emit([
    {
      type: 'content-result',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: retriedDetail.requestId,
      result: { kind: 'title.detail', detail: { state: 'absent' } },
    },
  ]);

  await expect(loading).resolves.toEqual({ kind: 'title.detail', detail: { state: 'absent' } });
  expect(createWorker).toHaveBeenCalledTimes(2);
  services.close();
  expect(replacement.terminate).toHaveBeenCalledOnce();
});

it('does not replace a live Worker for a request-scoped provider failure', async () => {
  const worker = new FakeWorker();
  const createWorker = vi.fn(() => worker as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const loading = services.content.query({
    kind: 'title.detail',
    title: { type: 'tv', id: 213344 },
    region: 'US',
  });
  const detail = worker.posted[0];
  if (detail?.type !== 'content-query') throw new Error('detail query was not sent');
  worker.emit([
    {
      type: 'content-error',
      protocol: CONTENT_SERVICE_PROTOCOL,
      requestId: detail.requestId,
      error: { code: 'unavailable', message: 'TMDB did not answer', retryable: true },
    },
  ]);

  await expect(loading).rejects.toMatchObject({
    failure: { code: 'unavailable', message: 'TMDB did not answer' },
    scope: 'request',
  });
  expect(createWorker).toHaveBeenCalledOnce();
  services.close();
});

it('stops replaying content after four transport replacements when every generation dies', async () => {
  const workers = Array.from({ length: 6 }, () => new FakeWorker());
  const createWorker = vi.fn<() => Worker>();
  for (const worker of workers) createWorker.mockReturnValueOnce(worker as unknown as Worker);
  const services = createWorkerServiceSession({ createWorker });

  const opening = services.library.open(openOptions);
  const first = workers[0]!;
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
  const loading = services.content.query({ kind: 'service.regions' });

  for (let generation = 0; generation < 5; generation += 1) {
    const current = workers[generation]!;
    await expect
      .poll(() =>
        current.posted.some(
          (message) =>
            message.type === 'content-query' && message.request.kind === 'service.regions',
        ),
      )
      .toBe(true);
    current.fail(`worker ${generation + 1} failed`);
    if (generation === 4) break;
    const next = workers[generation + 1]!;
    await expect.poll(() => next.posted.length).toBe(1);
    const hello = next.posted[0];
    if (hello?.type !== 'hello') throw new Error('replacement hello was not sent');
    next.emit([
      {
        type: 'ready',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: hello.requestId,
        relayMembership: null,
        version: { ...version, instance: `worker-${generation + 2}` },
      },
    ]);
  }

  await expect(loading).rejects.toMatchObject({
    failure: {
      code: 'unavailable',
      message: 'content transport recovery was exhausted',
      retryable: true,
    },
    scope: 'transport',
  });
  // The library supervisor independently keeps its authority healthy, but the exhausted content operation must not
  // follow it into a sixth generation or turn that health recovery into an unbounded query replay.
  const sixth = workers[5]!;
  await expect.poll(() => sixth.posted.length).toBe(1);
  expect(createWorker).toHaveBeenCalledTimes(6);
  expect(sixth.posted[0]).toMatchObject({ type: 'hello' });
  expect(sixth.posted).not.toContainEqual(
    expect.objectContaining({ type: 'content-query', request: { kind: 'service.regions' } }),
  );
  services.close();
});

it('cancels promptly while a transport replacement is reopening the paired library', async () => {
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
  const controller = new AbortController();
  const loading = services.content.query({ kind: 'service.regions' }, controller.signal);
  await expect.poll(() => first.posted.length).toBe(2);
  first.fail();
  await expect.poll(() => replacement.posted.length).toBe(1);
  controller.abort();
  await expect(loading).rejects.toMatchObject({
    failure: { code: 'cancelled' },
    scope: 'local',
  });

  const replacementHello = replacement.posted[0];
  if (replacementHello?.type !== 'hello') throw new Error('replacement hello was not sent');
  replacement.emit([
    {
      type: 'ready',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: replacementHello.requestId,
      relayMembership: null,
      version: { ...version, instance: 'worker-2' },
    },
  ]);
  await Promise.resolve();
  await Promise.resolve();
  expect(replacement.posted).toEqual([replacementHello]);
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
