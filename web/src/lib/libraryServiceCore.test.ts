import { describe, expect, it, vi } from 'vitest';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryCommand,
  type LibraryObservation,
  type LibraryQuery,
  type LibrarySelection,
  type LibrarySelectionValue,
  type TitleView,
} from './libraryServiceProtocol';
import { LibraryServiceCore } from './libraryServiceCore';

const title = { type: 'movie' as const, id: 7 };

function authority() {
  let listed = false;
  let reaction: TitleView['reaction'] = null;
  const operations: string[] = [];
  const selected: LibrarySelection[] = [];
  const view = (): TitleView => ({
    kind: 'title',
    title,
    listed,
    watched: false,
    reaction,
    standing: listed ? 'watchlist' : null,
    progress: null,
    episodes: [],
  });
  return {
    generation: 'generation-1',
    operations,
    selected,
    async select(selection: LibrarySelection): Promise<LibrarySelectionValue> {
      selected.push(selection);
      if (selection.kind !== 'title') throw new Error('unsupported selection');
      return view();
    },
    async command(command: LibraryCommand, operationId: string) {
      operations.push(operationId);
      if (command.kind === 'watchlist.add') {
        if (listed) return { outcome: 'unchanged' as const, delivery: 'synced' as const };
        listed = true;
        return { outcome: 'applied' as const, delivery: 'queued' as const };
      }
      if (command.kind === 'reaction.set') {
        if (reaction === command.reaction)
          return { outcome: 'unchanged' as const, delivery: 'synced' as const };
        reaction = command.reaction;
        return { outcome: 'applied' as const, delivery: 'synced' as const };
      }
      throw new Error('unsupported command');
    },
    async query(_query: LibraryQuery): Promise<never> {
      throw new Error('unsupported query');
    },
    async observe(_observation: LibraryObservation) {
      return 'unchanged' as const;
    },
    close: vi.fn(),
  };
}

const hello = {
  type: 'hello' as const,
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId: 'hello-1',
  clientId: 'tab-1',
  libraryKey: 'library-key',
};

const subscribe = {
  type: 'subscribe' as const,
  protocol: LIBRARY_SERVICE_PROTOCOL,
  requestId: 'subscribe-1',
  subscriptionId: 'title-7',
  selection: { kind: 'title' as const, title },
};

describe('LibraryServiceCore', () => {
  it('opens one authority and publishes a versioned title replacement', async () => {
    const held = authority();
    const open = vi.fn(async () => held);
    const core = new LibraryServiceCore(open, 'instance-1');

    await expect(core.dispatch(hello)).resolves.toEqual([
      {
        type: 'ready',
        protocol: LIBRARY_SERVICE_PROTOCOL,
        requestId: 'hello-1',
        version: { instance: 'instance-1', generation: 'generation-1', revision: 0 },
      },
    ]);
    const messages = await core.dispatch(subscribe);

    expect(open).toHaveBeenCalledOnce();
    expect(messages.map(({ type }) => type)).toEqual(['update', 'subscribed']);
    expect(messages[0]).toMatchObject({
      type: 'update',
      subscriptionId: 'title-7',
      version: { revision: 0 },
      value: { kind: 'title', title, listed: false },
    });
  });

  it('serializes semantic commands, republishes only changed views, and deduplicates operation IDs', async () => {
    const held = authority();
    const core = new LibraryServiceCore(async () => held, 'instance-1');
    await core.dispatch(hello);
    await core.dispatch(subscribe);
    const command = {
      type: 'command' as const,
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'command-1',
      operationId: 'operation-1',
      command: { kind: 'watchlist.add' as const, title },
    };

    const first = await core.dispatch(command);
    const duplicate = await core.dispatch({ ...command, requestId: 'command-2' });
    const unchanged = await core.dispatch({
      ...command,
      requestId: 'command-3',
      operationId: 'operation-2',
    });

    expect(first.map(({ type }) => type)).toEqual(['update', 'command-result']);
    expect(first[0]).toMatchObject({ value: { listed: true, standing: 'watchlist' } });
    expect(first[1]).toMatchObject({
      outcome: 'applied',
      delivery: 'queued',
      version: { revision: 1 },
    });
    expect(duplicate).toEqual([
      expect.objectContaining({
        type: 'command-result',
        requestId: 'command-2',
        outcome: 'applied',
        delivery: 'queued',
        version: expect.objectContaining({ revision: 1 }),
      }),
    ]);
    expect(unchanged).toEqual([
      expect.objectContaining({
        type: 'command-result',
        outcome: 'unchanged',
        delivery: 'synced',
        version: expect.objectContaining({ revision: 1 }),
      }),
    ]);
    expect(held.operations).toEqual(['operation-1', 'operation-2']);
  });

  it('rejects an operation ID reused for different intent', async () => {
    const core = new LibraryServiceCore(async () => authority(), 'instance-1');
    await core.dispatch(hello);
    await core.dispatch({
      type: 'command',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'command-1',
      operationId: 'operation-1',
      command: { kind: 'watchlist.add', title },
    });

    const messages = await core.dispatch({
      type: 'command',
      protocol: LIBRARY_SERVICE_PROTOCOL,
      requestId: 'command-2',
      operationId: 'operation-1',
      command: { kind: 'reaction.set', title, reaction: 'love' },
    });

    expect(messages).toEqual([
      expect.objectContaining({
        type: 'error',
        requestId: 'command-2',
        error: expect.objectContaining({ code: 'conflict', retryable: false }),
      }),
    ]);
  });

  it('requires a handshake and closes its one authority once', async () => {
    const held = authority();
    const core = new LibraryServiceCore(async () => held, 'instance-1');
    await expect(core.dispatch(subscribe)).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'not-ready' }),
      }),
    ]);

    await core.dispatch(hello);
    await core.close();
    await core.close();

    expect(held.close).toHaveBeenCalledOnce();
    await expect(core.dispatch(subscribe)).resolves.toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'cancelled' }),
      }),
    ]);
  });
});
