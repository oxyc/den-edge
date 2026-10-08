import { expect, it, vi } from 'vitest';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import { LibraryServiceWorkerHost } from './libraryServiceWorkerHost';

class FakeScope {
  listener?: (event: MessageEvent<unknown>) => void;
  posted: LibraryServiceServerMessage[][] = [];

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  postMessage(messages: LibraryServiceServerMessage[]): void {
    this.posted.push(messages);
  }

  emit(data: unknown): void {
    this.listener?.({ data } as MessageEvent<unknown>);
  }
}

const hello = (requestId: string): LibraryServiceClientMessage => ({
  type: 'hello',
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId,
  clientId: 'tab-1',
  libraryKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  mode: 'online' as const,
});

const ready = (requestId: string): LibraryServiceServerMessage => ({
  type: 'ready',
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId,
  version: { instance: 'worker-1', generation: null, revision: 0 },
});

it('serializes requests and posts each ordered reply batch once', async () => {
  const scope = new FakeScope();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const dispatched: string[] = [];
  const dispatcher = {
    async dispatch(input: unknown) {
      const request = input as LibraryServiceClientMessage;
      dispatched.push(request.requestId);
      if (request.requestId === 'first') await first;
      return [ready(request.requestId), ready(`${request.requestId}-after`)];
    },
    listen() {
      return () => {};
    },
    close: vi.fn(),
  };
  const host = new LibraryServiceWorkerHost(scope, dispatcher);

  scope.emit(hello('first'));
  scope.emit(hello('second'));
  await expect.poll(() => dispatched).toEqual(['first']);
  releaseFirst();
  await expect.poll(() => scope.posted.length).toBe(2);

  expect(dispatched).toEqual(['first', 'second']);
  expect(
    scope.posted.map((batch) =>
      batch.map((message) => ('requestId' in message ? message.requestId : undefined)),
    ),
  ).toEqual([
    ['first', 'first-after'],
    ['second', 'second-after'],
  ]);
  await host.close();
});

it('rejects malformed input and replaces a malformed dispatcher batch', async () => {
  const scope = new FakeScope();
  const dispatch = vi.fn(
    async () => [ready('valid'), { type: 'invented' }] as unknown as LibraryServiceServerMessage[],
  );
  const host = new LibraryServiceWorkerHost(scope, {
    dispatch,
    listen() {
      return () => {};
    },
    close() {},
  });

  scope.emit({ ...hello('wrong-version'), protocol: 99 });
  await expect.poll(() => scope.posted.length).toBe(1);
  expect(scope.posted[0]).toMatchObject([
    {
      type: 'error',
      requestId: 'wrong-version',
      error: { code: 'protocol-mismatch', expectedProtocol: LIBRARY_SERVICE_PROTOCOL },
    },
  ]);
  expect(dispatch).not.toHaveBeenCalled();

  scope.emit(hello('valid'));
  await expect.poll(() => scope.posted.length).toBe(2);
  expect(scope.posted[1]).toMatchObject([
    { type: 'error', requestId: 'valid', error: { code: 'internal', retryable: true } },
  ]);
  await host.close();
});

it('stops accepting and publishing work before closing the dispatcher', async () => {
  const scope = new FakeScope();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const close = vi.fn();
  const host = new LibraryServiceWorkerHost(scope, {
    async dispatch() {
      await pending;
      return [ready('pending')];
    },
    listen() {
      return () => {};
    },
    close,
  });
  scope.emit(hello('pending'));
  await Promise.resolve();

  const closing = host.close();
  scope.emit(hello('ignored'));
  release();
  await closing;

  expect(scope.posted).toEqual([]);
  expect(scope.listener).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it('forwards authority-driven batches without duplicating dispatch replies', async () => {
  const scope = new FakeScope();
  let publish!: (messages: LibraryServiceServerMessage[]) => void;
  const stopListening = vi.fn();
  const host = new LibraryServiceWorkerHost(scope, {
    async dispatch(input) {
      return [ready((input as LibraryServiceClientMessage).requestId)];
    },
    listen(listener) {
      publish = listener;
      return stopListening;
    },
    close() {},
  });

  scope.emit(hello('request'));
  await expect.poll(() => scope.posted.length).toBe(1);
  publish([
    {
      type: 'status',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      status: {
        kind: 'ready',
        version: { instance: 'worker-1', generation: null, revision: 1 },
      },
    },
  ]);

  expect(scope.posted.map((batch) => batch.map((message) => message.type))).toEqual([
    ['ready'],
    ['status'],
  ]);
  await host.close();
  expect(stopListening).toHaveBeenCalledOnce();
});
