import { afterEach, expect, it, vi } from 'vitest';
import { LIBRARY_SHARED_WORKER_PROTOCOL } from './librarySharedWorkerProtocol';
import {
  prewarmSharedLibraryWorker,
  SharedWorkerLibraryServiceTransport,
} from './libraryServiceSharedWorkerTransport';
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
  static all: FakeSharedWorker[] = [];
  readonly port = new FakeTarget();
  constructor(
    readonly url: URL,
    readonly options: { type: string; name: string },
  ) {
    super();
    FakeSharedWorker.latest = this;
    FakeSharedWorker.all.push(this);
  }
}

const original = globalThis.SharedWorker;
afterEach(() => {
  vi.stubGlobal('SharedWorker', original);
  FakeSharedWorker.latest = undefined;
  FakeSharedWorker.all = [];
});

it('prewarms the exact identity realm and releases its idle port after adoption', async () => {
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  const opening = hello();
  await prewarmSharedLibraryWorker(opening);
  const prewarm = FakeSharedWorker.latest!;
  const transport = new SharedWorkerLibraryServiceTransport();
  transport.send(opening);
  await expect.poll(() => FakeSharedWorker.all).toHaveLength(2);
  const adopted = FakeSharedWorker.latest!;
  expect(adopted.options.name).toBe(prewarm.options.name);

  adopted.port.emit('message', {
    type: 'den-library-connected',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  await expect(transport.ready).resolves.toBeUndefined();
  expect(prewarm.port.posted).toContainEqual({
    type: 'den-library-disconnect',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  expect(prewarm.port.closed).toBe(true);
  transport.close();
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
  expect(FakeSharedWorker.latest!.port.posted).toContainEqual({
    type: 'den-library-disconnect',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  expect(FakeSharedWorker.latest!.port.closed).toBe(true);
});

it('disconnects immediately when an authority rejects its opening hello', async () => {
  vi.stubGlobal('SharedWorker', FakeSharedWorker);
  const transport = new SharedWorkerLibraryServiceTransport();
  transport.send(hello());
  await expect.poll(() => FakeSharedWorker.latest).toBeTruthy();
  const worker = FakeSharedWorker.latest!;
  worker.port.emit('message', {
    type: 'den-library-connected',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  worker.port.emit('message', [
    {
      type: 'error',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'open',
      error: { code: 'unavailable', message: 'offline', retryable: true },
    },
  ]);

  expect(worker.port.posted).toContainEqual({
    type: 'den-library-disconnect',
    protocol: LIBRARY_SHARED_WORKER_PROTOCOL,
  });
  expect(worker.port.closed).toBe(true);
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
