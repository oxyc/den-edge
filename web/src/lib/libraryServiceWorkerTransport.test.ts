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
  postFailure?: Error;

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    if (this.postFailure) throw this.postFailure;
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
  wire: 4,
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

it('posts requests and delivers a batch in order', () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const received: unknown[] = [];
  transport.listen((message) => received.push(message));

  transport.send(request);
  expect(worker.posted).toEqual([request]);
  worker.emit('message', { data: [ready('first'), ready('second')] } as MessageEvent<unknown>);
  expect(received).toEqual([ready('first'), ready('second')]);
  transport.close();
});

it('rejects one uncloneable request without terminating the shared Worker', () => {
  const worker = new FakeWorker();
  const transport = transportFor(worker);
  const received = vi.fn();
  transport.listen(received);
  worker.postFailure = new DOMException(
    "Failed to execute 'postMessage' on 'Worker': object could not be cloned.",
    'DataCloneError',
  );

  expect(() => transport.send(request)).toThrowError(/could not be cloned/);
  expect(received).not.toHaveBeenCalled();
  expect(worker.terminate).not.toHaveBeenCalled();

  worker.postFailure = undefined;
  transport.send({ ...request, requestId: 'after-clone-error' });
  expect(worker.posted).toEqual([{ ...request, requestId: 'after-clone-error' }]);
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

it('rejects only the request the Worker host refused', async () => {
  const worker = new FakeWorker();
  const client = new LibraryServiceClient(transportFor(worker), 'tab-1');
  const statuses = vi.fn();
  client.onStatus(statuses);
  const opening = client.open({
    libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    mode: 'online',
  });
  const hello = worker.posted[0] as LibraryServiceClientMessage;
  const refusal = {
    code: 'protocol-mismatch' as const,
    message: 'library service protocol 4 is not supported',
    retryable: false,
    expectedProtocol: LIBRARY_SERVICE_PROTOCOL,
  };

  worker.emit('message', {
    data: [
      {
        type: 'error',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: hello.requestId,
        error: refusal,
      },
    ],
  } as MessageEvent<unknown>);

  await expect(opening).rejects.toMatchObject({ failure: refusal });
  expect(statuses).not.toHaveBeenCalled();
  expect(worker.terminate).not.toHaveBeenCalled();
  client.close();
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
