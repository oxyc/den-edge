import { expect, it } from 'vitest';
import {
  LIBRARY_SERVICE_PROTOCOL,
  type LibraryCommand,
  type LibraryObservation,
  type LibraryQuery,
  type LibrarySelection,
  type LibrarySelectionValue,
  type LibraryServiceServerMessage,
} from './libraryServiceProtocol';
import { LibraryServiceCore } from './libraryServiceCore';
import { InlineLibraryServiceTransport } from './libraryServiceInlineTransport';

const title = { type: 'movie' as const, id: 7 };

it('delivers cloned messages asynchronously and preserves request order', async () => {
  let listed = false;
  const received: LibraryServiceServerMessage[] = [];
  const commands: string[] = [];
  const core = new LibraryServiceCore(
    async () => ({
      generation: null,
      async select(_selection: LibrarySelection): Promise<LibrarySelectionValue> {
        return {
          kind: 'title',
          title,
          listed,
          watched: false,
          reaction: null,
          standing: listed ? 'watchlist' : null,
          progress: null,
          episodes: [],
        };
      },
      async command(command: LibraryCommand, operationId: string) {
        commands.push(operationId);
        if (command.kind !== 'watchlist.add' || listed)
          return { outcome: 'unchanged' as const, delivery: 'synced' as const };
        listed = true;
        return { outcome: 'applied' as const, delivery: 'synced' as const };
      },
      async query(_query: LibraryQuery): Promise<never> {
        throw new Error('unsupported query');
      },
      async observe(_observation: LibraryObservation) {
        return 'unchanged' as const;
      },
    }),
    'inline-1',
  );
  const transport = new InlineLibraryServiceTransport(core);
  transport.listen((message) => received.push(message));
  transport.send({
    type: 'hello',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: 'hello',
    clientId: 'tab',
    libraryKey: 'secret',
  });
  const command = {
    type: 'command' as const,
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: 'command',
    operationId: 'original-operation',
    command: { kind: 'watchlist.add' as const, title },
  };
  transport.send(command);
  command.operationId = 'mutated-after-send';

  expect(received).toEqual([]);
  await expect.poll(() => received.length).toBe(2);

  expect(received.map(({ type }) => type)).toEqual(['ready', 'command-result']);
  expect(commands).toEqual(['original-operation']);
  expect(received[1]).toMatchObject({ operationId: 'original-operation', outcome: 'applied' });
  transport.close();
});

it('does not deliver a request after the transport closes', async () => {
  let opened = 0;
  const core = new LibraryServiceCore(async () => {
    opened++;
    throw new Error('must not open');
  });
  const transport = new InlineLibraryServiceTransport(core);
  const received: LibraryServiceServerMessage[] = [];
  transport.listen((message) => received.push(message));
  transport.send({
    type: 'hello',
    protocol: LIBRARY_SERVICE_PROTOCOL,
    requestId: 'hello',
    clientId: 'tab',
    libraryKey: 'secret',
  });
  transport.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(opened).toBe(0);
  expect(received).toEqual([]);
});
