import { expect, it, vi } from 'vitest';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import { LibraryServiceClient } from './libraryServiceClient';
import { WorkerLibraryServiceTransport } from './libraryServiceWorkerTransport';
import { CONTENT_SERVICE_PROTOCOL } from './contentServiceProtocol';

class FakeWorker {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly posted: unknown[] = [];
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const request: LibraryServiceClientMessage = {
  type: 'hello',
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId: 'hello',
  clientId: 'tab-1',
  libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  mode: 'online',
};

const ready = (requestId: string): LibraryServiceServerMessage => ({
  type: 'ready',
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId,
  relayMembership: null,
  version: { instance: 'worker-1', generation: null, revision: 0 },
});

const transportFor = (worker: FakeWorker) =>
  new WorkerLibraryServiceTransport(worker as unknown as Worker);

it('validates requests and delivers a decoded batch in order', () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const received: unknown[] = [];
  transport.listen((message) => received.push(message));

  transport.send(request);
  expect(worker.posted).toEqual([request]);
  worker.emit('message', { data: [ready('first'), ready('second')] } as MessageEvent<unknown>);
  expect(received).toEqual([ready('first'), ready('second')]);

  expect(() =>
    transport.send({ ...request, protocol: 99 } as unknown as LibraryServiceClientMessage),
  ).toThrow('protocol 99 is not supported');
  expect(worker.posted).toHaveLength(1);
  transport.close();
});

it('multiplexes library and content replies onto separate channels', () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const library: unknown[] = [];
  const content: unknown[] = [];
  transport.listen((message) => library.push(message));
  transport.contentTransport().listen((message) => content.push(message));

  const regions = {
    type: 'content-result' as const,
    protocol: CONTENT_SERVICE_PROTOCOL,
    requestId: 'regions',
    result: { kind: 'service.regions' as const, regions: [] },
  };
  worker.emit('message', { data: [regions, ready('library')] } as MessageEvent<unknown>);

  expect(content).toEqual([regions]);
  expect(library).toEqual([ready('library')]);
  transport.close();
});

it('rejects a malformed batch without delivering a partial batch', () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const received: LibraryServiceServerMessage[] = [];
  transport.listen((message) => received.push(message as LibraryServiceServerMessage));

  worker.emit('message', {
    data: [ready('valid'), { type: 'invented', protocol: LIBRARY_SERVICE_PROTOCOL }],
  } as MessageEvent<unknown>);

  expect(received).toMatchObject([
    { type: 'error', error: { code: 'invalid-request', retryable: false } },
  ]);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect([...worker.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});

it('rejects an empty batch instead of leaving a request pending', () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const received: LibraryServiceServerMessage[] = [];
  transport.listen((message) => received.push(message as LibraryServiceServerMessage));

  worker.emit('message', { data: [] } as unknown as MessageEvent<unknown>);

  expect(received).toMatchObject([
    { type: 'error', error: { code: 'invalid-request', retryable: false } },
  ]);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects pending client work on a terminal worker failure and closes cleanly', async () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const client = new LibraryServiceClient(transport, 'tab-1');
  const statuses = vi.fn();
  client.onStatus(statuses);
  const opening = client.open({
    libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    mode: 'online',
  });
  const preventDefault = vi.fn();

  worker.emit('error', { message: 'worker crashed', preventDefault } as unknown as ErrorEvent);
  worker.emit('messageerror', { preventDefault: vi.fn() } as unknown as MessageEvent<unknown>);

  expect(preventDefault).toHaveBeenCalledOnce();
  await expect(opening).rejects.toMatchObject({
    failure: { code: 'unavailable', message: 'worker crashed', retryable: true },
  });
  expect(statuses).toHaveBeenCalledWith({
    kind: 'failed',
    error: { code: 'unavailable', message: 'worker crashed', retryable: true },
  });
  expect(worker.terminate).toHaveBeenCalledOnce();
  client.close();
});
