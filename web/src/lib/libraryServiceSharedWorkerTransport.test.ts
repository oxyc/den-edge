import { afterEach, expect, it, vi } from 'vitest';
import { LIBRARY_SHARED_WORKER_PROTOCOL } from './librarySharedWorkerProtocol';
import { SharedWorkerLibraryServiceTransport } from './libraryServiceSharedWorkerTransport';
import { LIBRARY_SERVICE_PROTOCOL } from './libraryServiceProtocol';

class FakeTarget extends EventTarget {
  posted: unknown[] = [];
  closed = false;
  start = vi.fn();
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    this.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { data }));
  }
}

class FakeSharedWorker extends EventTarget {
  static latest?: FakeSharedWorker;
  readonly port = new FakeTarget();
  constructor(
    readonly url: URL,
    readonly options: { type: string; name: string },
  ) {
    super();
    FakeSharedWorker.latest = this;
  }
}

const original = globalThis.SharedWorker;
afterEach(() => {
  vi.stubGlobal('SharedWorker', original);
  FakeSharedWorker.latest = undefined;
});

it('waits for the versioned connection handshake and disconnects explicitly', async () => {
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  const transport = new SharedWorkerLibraryServiceTransport();
  transport.send(hello());
  await expect.poll(() => FakeSharedWorker.latest).toBeTruthy();
  const worker = FakeSharedWorker.latest!;
  worker.port.emit('message', {
    type: 'den-library-connected',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  await expect(transport.ready).resolves.toBeUndefined();

  transport.close();
  expect(worker.port.posted).toContainEqual({
    type: 'den-library-disconnect',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  expect(worker.port.closed).toBe(true);
});

it('turns a SharedWorker startup failure into the supervisor transport failure shape', async () => {
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  const transport = new SharedWorkerLibraryServiceTransport();
  const failures: unknown[] = [];
  transport.listen((message) => failures.push(message));
  transport.send(hello());
  await expect.poll(() => FakeSharedWorker.latest).toBeTruthy();
  FakeSharedWorker.latest!.dispatchEvent(
    Object.assign(new Event('error', { cancelable: true }), { message: 'worker refused' }),
  );

  await expect(transport.ready).rejects.toThrow('worker refused');
  expect(failures).toMatchObject([
    { type: 'error', error: { code: 'unavailable', retryable: true } },
  ]);
});

function hello() {
  return {
    type: 'hello' as const,
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: 'open',
    clientId: 'tab',
    libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    wire: 4 as const,
    mode: 'local' as const,
  };
}
