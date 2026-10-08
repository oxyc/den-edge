import { expect, it, vi } from 'vitest';
import { LibraryServiceError, type LibraryServiceOpenOptions } from './libraryServiceClient';
import type { LibraryServiceClientPort } from './libraryServiceSupervisor';
import { LibraryServiceSupervisor } from './libraryServiceSupervisor';
import type {
  LibraryCommand,
  LibraryObservation,
  LibraryQuery,
  LibraryQueryResult,
  LibrarySelection,
  LibrarySelectionValue,
  LibraryServiceCommandResult,
  LibraryServiceFailure,
  LibrarySessionStatus,
  LibraryVersion,
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
    reject: (error: LibraryServiceError) => void;
  }> = [];
  openFailure?: LibraryServiceFailure;
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

  command(_command: LibraryCommand, _operationId?: string): Promise<LibraryServiceCommandResult> {
    return new Promise((_resolve, reject) => this.commands.push({ reject }));
  }

  query(_query: LibraryQuery): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    return Promise.reject(new Error('unused'));
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
    const subscription = { selection, listener };
    this.subscriptions.push(subscription);
    listener(continueValue(this.instance), this.version(this.subscriptionRevision));
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
    for (const listener of this.statusListeners) listener({ kind: 'failed', error: failure });
  }

  version(revision: number): LibraryVersion {
    return { instance: this.instance, generation: 'generation-1', revision };
  }
}

const unavailable = (message: string): LibraryServiceFailure => ({
  code: 'unavailable',
  message,
  retryable: true,
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
});

it('rejects in-flight commands, preserves stale views, and installs a fresh replacement', async () => {
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
  await expect(command).rejects.toMatchObject({
    failure: { code: 'unavailable', message: 'worker crashed' },
  });
  await vi.waitFor(() => expect(created).toHaveLength(2));
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
  expect(second.commands).toHaveLength(0);
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

  first.fail(unavailable('worker crashed'));

  await vi.waitFor(() => expect(second.subscriptions).toHaveLength(1));
  expect(second.events).toEqual([
    'open',
    'observe:title-shape',
    'observe:lifecycle',
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
