import { expect, it, vi } from 'vitest';
import { LibraryServiceError, type LibraryServiceOpenOptions } from './libraryServiceClient';
import type { LibraryServiceClientPort } from './libraryServiceSupervisor';
import { LibraryServiceSupervisor } from './libraryServiceSupervisor';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryCommand,
  type LibraryObservation,
  type LibraryQuery,
  type LibraryQueryResult,
  type LibrarySelection,
  type LibrarySelectionValue,
  type LibraryServiceCommandResult,
  type LibraryServiceFailure,
  type LibrarySessionStatus,
  type LibraryTask,
  type LibraryTaskResult,
  type LibraryVersion,
} from './libraryServiceProtocol';

type Subscription = {
  selection: LibrarySelection;
  listener: (value: LibrarySelectionValue, version: LibraryVersion) => void;
};

class FakeClient implements LibraryServiceClientPort {
  readonly opened: LibraryServiceOpenOptions[] = [];
  readonly subscriptions: Subscription[] = [];
  readonly statusListeners = new Set<(status: LibrarySessionStatus) => void>();
  readonly close = vi.fn();
  readonly events: string[] = [];
  readonly observations: LibraryObservation[] = [];
  readonly commands: Array<{
    operationId?: string;
    resolve: (result: LibraryServiceCommandResult) => void;
    reject: (error: LibraryServiceError) => void;
  }> = [];
  readonly tasks: Array<{
    operationId?: string;
    resolve: (result: { result: LibraryTaskResult; version: LibraryVersion }) => void;
    reject: (error: LibraryServiceError) => void;
  }> = [];
  openFailure?: LibraryServiceFailure;
  subscriptionFailure?: { kind: LibrarySelection['kind']; failure: LibraryServiceFailure };
  instance = 'worker-1';
  subscriptionRevision = 1;

  async open(options: LibraryServiceOpenOptions): Promise<LibraryVersion> {
    this.opened.push(options);
    this.events.push('open');
    if (this.openFailure) {
      this.fail(this.openFailure);
      throw new LibraryServiceError(this.openFailure);
    }
    return this.version(0);
  }

  command(_command: LibraryCommand, operationId?: string): Promise<LibraryServiceCommandResult> {
    return new Promise((resolve, reject) => this.commands.push({ operationId, resolve, reject }));
  }

  query(_query: LibraryQuery): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    return Promise.reject(new Error('unused'));
  }

  task(
    _task: LibraryTask,
    operationId?: string,
  ): Promise<{ result: LibraryTaskResult; version: LibraryVersion }> {
    return new Promise((resolve, reject) => this.tasks.push({ operationId, resolve, reject }));
  }

  observe(observation: LibraryObservation): Promise<LibraryVersion> {
    this.events.push(`observe:${observation.kind}`);
    this.observations.push(observation);
    return Promise.resolve(this.version(this.observations.length + 1));
  }

  async subscribe(
    selection: LibrarySelection,
    listener: (value: LibrarySelectionValue, version: LibraryVersion) => void,
  ): Promise<() => void> {
    this.events.push(`subscribe:${selection.kind}`);
    if (this.subscriptionFailure?.kind === selection.kind)
      throw new LibraryServiceError(this.subscriptionFailure.failure);
    const subscription = { selection, listener };
    this.subscriptions.push(subscription);
    listener(selectionValue(selection, this.instance), this.version(this.subscriptionRevision));
    return () => {
      const index = this.subscriptions.indexOf(subscription);
      if (index >= 0) this.subscriptions.splice(index, 1);
    };
  }

  onStatus(listener: (status: LibrarySessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  fail(failure: LibraryServiceFailure): void {
    const error = new LibraryServiceError(failure);
    for (const command of this.commands.splice(0)) command.reject(error);
    for (const task of this.tasks.splice(0)) task.reject(error);
    for (const listener of this.statusListeners) listener({ kind: 'failed', error: failure });
  }

  version(revision: number): LibraryVersion {
    return { instance: this.instance, generation: 'generation-1', revision };
  }
}

class StaggeredSubscriptionClient extends FakeClient {
  readonly releaseSubscriptions: Array<() => void> = [];

  override subscribe(
    selection: LibrarySelection,
    listener: (value: LibrarySelectionValue, version: LibraryVersion) => void,
  ): Promise<() => void> {
    this.events.push(`subscribe:${selection.kind}`);
    const subscription = { selection, listener };
    this.subscriptions.push(subscription);
    return new Promise((resolve) =>
      this.releaseSubscriptions.push(() => {
        listener(selectionValue(selection, this.instance), this.version(this.subscriptionRevision));
        resolve(() => {
          const index = this.subscriptions.indexOf(subscription);
          if (index >= 0) this.subscriptions.splice(index, 1);
        });
      }),
    );
  }
}

const unavailable = (message: string): LibraryServiceFailure => ({
  code: 'unavailable',
  message,
  retryable: true,
});

it('replays an in-flight task with its original operation ID after a lost reply', async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  second.instance = 'worker-2';
  const queue = [first, second];
  const supervisor = new LibraryServiceSupervisor(() => queue.shift()!);
  await supervisor.open(openOptions);
  const task = supervisor.task({ kind: 'recovery.disable' }, 'disable-1');

  first.fail(unavailable('reply lost'));
  await vi.waitFor(() => expect(second.tasks).toHaveLength(1));
  expect(second.tasks[0]?.operationId).toBe('disable-1');
  second.tasks[0]!.resolve({
    result: { kind: 'recovery.disable', outcome: 'disabled' },
    version: second.version(1),
  });
  await expect(task).resolves.toMatchObject({ result: { outcome: 'disabled' } });
  supervisor.close();
});

const openOptions: LibraryServiceOpenOptions = {
  libraryKey: 'library-1',
  mode: 'online',
  legacyClock: { device: 'legacy-device', last: [10, 2, 'legacy-device'] },
};

const continueValue = (instance: string): LibrarySelectionValue => ({
  kind: 'continue',
  items: [
    {
      title: { type: 'movie', id: instance === 'worker-1' ? 1 : 2 },
      fraction: 0.5,
    },
  ],
  needsShapes: [],
});

const selectionValue = (selection: LibrarySelection, instance: string): LibrarySelectionValue => {
  if (selection.kind === 'history')
    return {
      kind: 'history',
      items: [
        {
          title: { type: 'movie', id: 680 },
          watchedAt: 1_800_000_000_000,
          episodes: 0,
        },
      ],
    };
  if (selection.kind === 'connections')
    return {
      kind: 'connections',
      apiKeys: { tmdb: { configured: true, masked: '••••-key' } },
      parentalPinConfigured: false,
      remoteAccessConfigured: false,
      plugins: [
        {
          manifestUrl: 'https://den.example/scout/config/manifest.json',
          pendingApprovalOn: [{ id: 'aaaaaaaaaaaaaaaa', name: 'Living Room TV' }],
        },
      ],
      servers: [],
      devices: [
        {
          id: 'aaaaaaaaaaaaaaaa',
          name: 'Living Room TV',
          kind: 'tv',
          lastSeenAt: 1_800_000_000_000,
          libraryFormat: 4,
        },
      ],
      diagnostics: {
        libraryFormat: 4,
        pendingChanges: 0,
        selfDeviceId: 'bbbbbbbbbbbbbbbb',
      },
    };
  if (selection.kind === 'overview')
    return {
      kind: 'overview',
      owned: [{ type: 'movie', id: 617126 }],
      watched: [],
      watchlist: [{ type: 'movie', id: 617126 }],
      standings: [{ title: { type: 'movie', id: 617126 }, standing: 'watchlist' }],
      weighted: [],
      seeds: { watched: [], watchlisted: [{ type: 'movie', id: 617126 }] },
    };
  return continueValue(instance);
};

it('replays an in-flight command with the same operation ID and preserves stale views', async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  second.instance = 'worker-2';
  const created: FakeClient[] = [];
  const queue = [first, second];
  const supervisor = new LibraryServiceSupervisor(() => {
    const client = queue.shift()!;
    created.push(client);
    return client;
  });
  const snapshots: Array<{
    connection: string;
    value?: LibrarySelectionValue;
    version?: LibraryVersion;
  }> = [];
  supervisor.subscribeSnapshot({ kind: 'continue' }, (snapshot) => snapshots.push(snapshot));
  await supervisor.open(openOptions);
  const command = supervisor.command(
    { kind: 'watchlist.add', title: { type: 'movie', id: 9 } },
    'operation-1',
  );

  first.fail(unavailable('worker crashed'));
  await vi.waitFor(() => expect(created).toHaveLength(2));
  await vi.waitFor(() => expect(second.commands).toHaveLength(1));
  expect(second.commands[0]?.operationId).toBe('operation-1');
  second.commands[0]!.resolve({
    type: 'command-result',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: 'replacement',
    operationId: 'operation-1',
    outcome: 'applied',
    delivery: 'queued',
    version: second.version(2),
  });
  await expect(command).resolves.toMatchObject({ operationId: 'operation-1' });
  await vi.waitFor(() =>
    expect(snapshots.at(-1)).toMatchObject({
      connection: 'ready',
      value: { kind: 'continue', items: [{ title: { id: 2 } }] },
      version: { instance: 'worker-2' },
    }),
  );

  const reconnecting = snapshots.find(
    (snapshot) => snapshot.connection === 'reconnecting' && snapshot.value,
  );
  expect(reconnecting).toMatchObject({
    connection: 'reconnecting',
    value: { kind: 'continue', items: [{ title: { id: 1 } }] },
    version: { instance: 'worker-1' },
  });
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.opened).toEqual([openOptions]);
  expect(second.subscriptions[0]?.selection).toEqual({ kind: 'continue' });
  expect(second.commands).toHaveLength(1);
  supervisor.close();
});

it('replays only the latest service observations before requesting replacement views', async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  second.instance = 'worker-2';
  const queue = [first, second];
  const supervisor = new LibraryServiceSupervisor(() => queue.shift()!);
  supervisor.subscribeSnapshot({ kind: 'continue' }, () => {});
  await supervisor.open(openOptions);
  await supervisor.observe({
    kind: 'title-shape',
    title: { type: 'tv', id: 7 },
    seasons: [{ season: 1, episodes: 6 }],
  });
  await supervisor.observe({
    kind: 'title-shape',
    title: { type: 'tv', id: 7 },
    seasons: [{ season: 1, episodes: 8 }],
  });
  await supervisor.observe({
    kind: 'lifecycle',
    visible: true,
    online: true,
    playbackActive: false,
  });
  await supervisor.observe({ kind: 'foreground-ready' });

  first.fail(unavailable('worker crashed'));

  await vi.waitFor(() => expect(second.subscriptions).toHaveLength(1));
  expect(second.events).toEqual([
    'open',
    'observe:title-shape',
    'observe:lifecycle',
    'observe:foreground-ready',
    'subscribe:continue',
  ]);
  expect(second.observations).toEqual([
    {
      kind: 'title-shape',
      title: { type: 'tv', id: 7 },
      seasons: [{ season: 1, episodes: 8 }],
    },
    {
      kind: 'lifecycle',
      visible: true,
      online: true,
      playbackActive: false,
    },
    { kind: 'foreground-ready' },
  ]);
  supervisor.close();
});

it('reports the newest initial replacement version as the ready version', async () => {
  const client = new FakeClient();
  client.subscriptionRevision = 7;
  const supervisor = new LibraryServiceSupervisor(() => client);
  const statuses = vi.fn();
  supervisor.onStatus(statuses);
  supervisor.subscribeSnapshot({ kind: 'continue' }, () => {});

  const opened = await supervisor.open(openOptions);

  expect(opened).toEqual(client.version(7));
  expect(statuses).toHaveBeenLastCalledWith({ kind: 'ready', version: client.version(7) });
  supervisor.close();
});

it('publishes staggered initial Worker replacements together once the connection is complete', async () => {
  const client = new StaggeredSubscriptionClient();
  const supervisor = new LibraryServiceSupervisor(() => client);
  const events: string[] = [];
  supervisor.subscribeSnapshot({ kind: 'overview' }, (snapshot) => {
    if (snapshot.connection === 'ready') events.push('overview');
  });
  supervisor.subscribeSnapshot({ kind: 'continue' }, (snapshot) => {
    if (snapshot.connection === 'ready') events.push('continue');
  });
  supervisor.onStatus((status) => events.push(`status:${status.kind}`));

  const opening = supervisor.open(openOptions);
  await vi.waitFor(() => expect(client.releaseSubscriptions).toHaveLength(2));

  client.releaseSubscriptions[0]!();
  await Promise.resolve();
  expect(events).toEqual([]);

  client.releaseSubscriptions[1]!();
  await expect(opening).resolves.toEqual(client.version(1));
  expect(events).toEqual(['overview', 'continue', 'status:ready']);
  supervisor.close();
});

it('binds History and Connections acquired while initial Worker replacements are still arriving', async () => {
  const client = new StaggeredSubscriptionClient();
  const supervisor = new LibraryServiceSupervisor(() => client);
  const events: string[] = [];
  supervisor.subscribeSnapshot({ kind: 'overview' }, (snapshot) => {
    if (snapshot.connection === 'ready') events.push('overview');
  });

  const opening = supervisor.open(openOptions);
  await vi.waitFor(() => expect(client.releaseSubscriptions).toHaveLength(1));
  supervisor.subscribeSnapshot({ kind: 'history' }, (snapshot) => {
    if (snapshot.connection === 'ready') events.push(`history:${snapshot.value?.kind}`);
  });
  supervisor.subscribeSnapshot({ kind: 'connections' }, (snapshot) => {
    if (snapshot.connection === 'ready') {
      const connections = snapshot.value?.kind === 'connections' ? snapshot.value : undefined;
      events.push(
        `connections:${connections?.devices[0]?.name}:${connections?.plugins[0]?.pendingApprovalOn[0]?.name}`,
      );
    }
  });
  client.releaseSubscriptions[0]!();
  await vi.waitFor(() => expect(client.releaseSubscriptions).toHaveLength(3));
  expect(events).toEqual([]);

  client.releaseSubscriptions[1]!();
  client.releaseSubscriptions[2]!();
  await expect(opening).resolves.toEqual(client.version(1));
  expect(events).toEqual([
    'overview',
    'history:history',
    'connections:Living Room TV:Living Room TV',
  ]);
  supervisor.close();
});

it('isolates a lazy subscription failure without weakening required root readiness', async () => {
  const client = new FakeClient();
  client.subscriptionFailure = {
    kind: 'history',
    failure: { code: 'internal', message: 'history projection failed', retryable: true },
  };
  const supervisor = new LibraryServiceSupervisor(() => client, { maxAutomaticRestarts: 0 });
  const root = vi.fn();
  const history = vi.fn();
  supervisor.subscribeSnapshot({ kind: 'continue' }, root);

  const opening = supervisor.open(openOptions);
  supervisor.subscribeSnapshot({ kind: 'history' }, history);

  await expect(opening).resolves.toEqual(client.version(1));
  expect(root).toHaveBeenLastCalledWith(
    expect.objectContaining({
      connection: 'ready',
      value: expect.objectContaining({ kind: 'continue' }),
    }),
  );
  expect(history).toHaveBeenLastCalledWith(
    expect.objectContaining({
      connection: 'failed',
      error: expect.objectContaining({ message: 'history projection failed' }),
    }),
  );
  supervisor.close();

  const requiredClient = new FakeClient();
  requiredClient.subscriptionFailure = {
    kind: 'continue',
    failure: { code: 'internal', message: 'root projection failed', retryable: false },
  };
  const required = new LibraryServiceSupervisor(() => requiredClient, {
    maxAutomaticRestarts: 0,
  });
  required.subscribeSnapshot({ kind: 'continue' }, () => {});
  await expect(required.open(openOptions)).rejects.toMatchObject({
    failure: { message: 'root projection failed' },
  });
  required.close();
});

it('stops after the bounded replacement attempt and retains the failed stale view', async () => {
  const first = new FakeClient();
  const replacement = new FakeClient();
  replacement.instance = 'worker-2';
  replacement.openFailure = unavailable('replacement also failed');
  const queue = [first, replacement];
  const factory = vi.fn(() => queue.shift()!);
  const supervisor = new LibraryServiceSupervisor(factory, { maxAutomaticRestarts: 1 });
  const snapshots = vi.fn();
  const statuses = vi.fn();
  supervisor.subscribeSnapshot({ kind: 'continue' }, snapshots);
  supervisor.onStatus(statuses);
  await supervisor.open(openOptions);

  first.fail(unavailable('worker crashed'));

  await vi.waitFor(() =>
    expect(statuses).toHaveBeenLastCalledWith({
      kind: 'failed',
      error: unavailable('replacement also failed'),
    }),
  );
  expect(factory).toHaveBeenCalledTimes(2);
  expect(snapshots).toHaveBeenLastCalledWith(
    expect.objectContaining({
      connection: 'failed',
      value: continueValue('worker-1'),
      version: first.version(1),
      error: unavailable('replacement also failed'),
    }),
  );
  await expect(
    supervisor.command({ kind: 'library.remove', title: { type: 'movie', id: 1 } }),
  ).rejects.toMatchObject({ failure: unavailable('replacement also failed') });
  supervisor.close();
});

it('restores the retry allowance after a successful replacement', async () => {
  const first = new FakeClient();
  const second = new FakeClient();
  second.instance = 'worker-2';
  const third = new FakeClient();
  third.instance = 'worker-3';
  const queue = [first, second, third];
  const factory = vi.fn(() => queue.shift()!);
  const supervisor = new LibraryServiceSupervisor(factory, { maxAutomaticRestarts: 1 });
  supervisor.subscribeSnapshot({ kind: 'continue' }, () => {});
  await supervisor.open(openOptions);

  first.fail(unavailable('first crash'));
  await vi.waitFor(() => expect(second.subscriptions).toHaveLength(1));
  second.fail(unavailable('later crash'));
  await vi.waitFor(() => expect(third.subscriptions).toHaveLength(1));

  expect(factory).toHaveBeenCalledTimes(3);
  supervisor.close();
});

it('does not restore a subscription removed while the replacement is opening', async () => {
  const first = new FakeClient();
  let resolveOpen!: (version: LibraryVersion) => void;
  const second = new FakeClient();
  second.instance = 'worker-2';
  second.open = vi.fn(
    (options: LibraryServiceOpenOptions) =>
      new Promise<LibraryVersion>((resolve) => {
        second.opened.push(options);
        resolveOpen = resolve;
      }),
  );
  const queue = [first, second];
  const supervisor = new LibraryServiceSupervisor(() => queue.shift()!);
  const stop = supervisor.subscribeSnapshot({ kind: 'continue' }, () => {});
  await supervisor.open(openOptions);

  first.fail(unavailable('worker crashed'));
  await vi.waitFor(() => expect(second.open).toHaveBeenCalledOnce());
  stop();
  resolveOpen(second.version(0));
  await vi.waitFor(() => expect(second.subscriptions).toHaveLength(0));
  supervisor.close();
});
