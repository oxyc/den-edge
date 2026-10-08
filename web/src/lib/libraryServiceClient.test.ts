import { expect, it, vi } from 'vitest';
import {
  LibraryServiceClient,
  LibraryServiceError,
  type LibraryServiceTransport,
} from './libraryServiceClient';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryServiceClientMessage,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';

class FakeTransport implements LibraryServiceTransport {
  sent: LibraryServiceClientMessage[] = [];
  listener?: (message: unknown) => void;
  closed = false;

  send(message: LibraryServiceClientMessage): void {
    this.sent.push(message);
  }

  listen(listener: (message: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(message: LibraryServiceServerMessage): void {
    this.listener?.(message);
  }

  close(): void {
    this.closed = true;
  }
}

const version = (revision: number, instance = 'worker-1') => ({
  instance,
  generation: 'generation-1',
  revision,
});

async function opened() {
  const transport = new FakeTransport();
  const client = new LibraryServiceClient(transport, 'client-1');
  const opening = client.open({ libraryKey: 'library-key', mode: 'online' });
  const hello = transport.sent[0]!;
  transport.emit({
    type: 'ready',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: hello.requestId,
    version: version(0),
  });
  await opening;
  return { client, transport };
}

it('installs only newer replacements from the opened service instance', async () => {
  const { client, transport } = await opened();
  const values = vi.fn();
  const subscribing = client.subscribe({ kind: 'title', title: { type: 'movie', id: 7 } }, values);
  const request = transport.sent.at(-1)!;
  if (request.type !== 'subscribe') throw new Error('expected subscribe');
  transport.emit({
    type: 'subscribed',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    version: version(0),
  });
  const stop = await subscribing;
  const value = {
    kind: 'title' as const,
    title: { type: 'movie' as const, id: 7 },
    listed: true,
    watched: false,
    reaction: null,
    standing: 'watchlist' as const,
    progress: null,
    episodes: [],
  };
  const update = (revision: number, instance = 'worker-1') =>
    transport.emit({
      type: 'update',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      subscriptionId: request.subscriptionId,
      version: version(revision, instance),
      value,
    });

  update(1);
  update(1);
  update(0);
  update(2, 'stopped-worker');

  expect(values).toHaveBeenCalledOnce();
  expect(values).toHaveBeenCalledWith(value, version(1));
  stop();
  client.close();
});

it('observes revised subscriptions before resolving a command result', async () => {
  const { client, transport } = await opened();
  const order: string[] = [];
  const subscribing = client.subscribe({ kind: 'title', title: { type: 'movie', id: 7 } }, () =>
    order.push('update'),
  );
  const subscription = transport.sent.at(-1)!;
  if (subscription.type !== 'subscribe') throw new Error('expected subscribe');
  transport.emit({
    type: 'subscribed',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: subscription.requestId,
    subscriptionId: subscription.subscriptionId,
    version: version(0),
  });
  await subscribing;
  const command = client
    .command({ kind: 'watchlist.add', title: { type: 'movie', id: 7 } }, 'operation-1')
    .then(() => order.push('result'));
  const request = transport.sent.at(-1)!;
  if (request.type !== 'command') throw new Error('expected command');
  transport.emit({
    type: 'update',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    subscriptionId: subscription.subscriptionId,
    version: version(1),
    value: {
      kind: 'title',
      title: { type: 'movie', id: 7 },
      listed: true,
      watched: false,
      reaction: null,
      standing: 'watchlist',
      progress: null,
      episodes: [],
    },
  });
  transport.emit({
    type: 'command-result',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: request.requestId,
    operationId: request.operationId,
    outcome: 'applied',
    delivery: 'synced',
    version: version(1),
  });
  await command;

  expect(order).toEqual(['update', 'result']);
  client.close();
});

it('correlates history subscriptions with history replacements only', async () => {
  const { client, transport } = await opened();
  const values = vi.fn();
  const subscribing = client.subscribe({ kind: 'history' }, values);
  const request = transport.sent.at(-1)!;
  if (request.type !== 'subscribe') throw new Error('expected subscribe');
  transport.emit({
    type: 'subscribed',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    version: version(0),
  });
  await subscribing;

  transport.emit({
    type: 'update',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    subscriptionId: request.subscriptionId,
    version: version(1),
    value: {
      kind: 'overview',
      owned: [],
      watched: [],
      watchlist: [],
      standings: [],
      weighted: [],
      seeds: { watched: [], watchlisted: [] },
    },
  });
  const history = {
    kind: 'history' as const,
    items: [{ title: { type: 'movie' as const, id: 7 }, watchedAt: 10, episodes: 0 }],
  };
  transport.emit({
    type: 'update',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    subscriptionId: request.subscriptionId,
    version: version(2),
    value: history,
  });

  expect(values).toHaveBeenCalledOnce();
  expect(values).toHaveBeenCalledWith(history, version(2));
  client.close();
});

it('correlates connection replacements and non-playback query results without title fields', async () => {
  const { client, transport } = await opened();
  const values = vi.fn();
  const subscribing = client.subscribe({ kind: 'connections' }, values);
  const subscription = transport.sent.at(-1)!;
  if (subscription.type !== 'subscribe') throw new Error('expected subscribe');
  transport.emit({
    type: 'subscribed',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: subscription.requestId,
    subscriptionId: subscription.subscriptionId,
    version: version(0),
  });
  await subscribing;
  const connections = {
    kind: 'connections' as const,
    apiKeys: {},
    parentalPinConfigured: false,
    remoteAccessConfigured: false,
    plugins: [],
    servers: [],
    devices: [],
    diagnostics: { libraryFormat: 4, pendingChanges: 0, selfDeviceId: '0123456789abcdef' },
  };
  transport.emit({
    type: 'update',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    subscriptionId: subscription.subscriptionId,
    version: version(1),
    value: connections,
  });
  expect(values).toHaveBeenCalledWith(connections, version(1));

  const querying = client.query({ kind: 'relay.membership' });
  const request = transport.sent.at(-1)!;
  if (request.type !== 'query') throw new Error('expected query');
  transport.emit({
    type: 'query-result',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: request.requestId,
    version: version(1),
    result: {
      kind: 'relay.membership',
      capability: { libraryId: 'a'.repeat(32), memberToken: 'b'.repeat(64) },
    },
  });
  await expect(querying).resolves.toMatchObject({
    result: { kind: 'relay.membership', capability: { libraryId: 'a'.repeat(32) } },
  });
  client.close();
});

it('correlates typed administrative task results', async () => {
  const { client, transport } = await opened();
  const running = client.task({
    kind: 'history.import',
    items: [{ title: { type: 'movie', id: 7 }, watchedAt: 10 }],
  });
  const request = transport.sent.at(-1)!;
  if (request.type !== 'task') throw new Error('expected task');
  transport.emit({
    type: 'task-result',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: request.requestId,
    operationId: request.operationId,
    result: { kind: 'history.import', written: 1, total: 1, complete: true },
    version: version(1),
  });
  await expect(running).resolves.toMatchObject({
    result: { kind: 'history.import', written: 1, complete: true },
  });
  client.close();
});

it('rejects pending work when closed', async () => {
  const transport = new FakeTransport();
  const client = new LibraryServiceClient(transport, 'client-1');
  const opening = client.open({ libraryKey: 'library-key', mode: 'online' });

  client.close();

  await expect(opening).rejects.toMatchObject<Partial<LibraryServiceError>>({
    failure: { code: 'cancelled', message: expect.any(String), retryable: false },
  });
  expect(transport.closed).toBe(true);
});
