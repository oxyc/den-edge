import { expect, test } from 'vitest';
import type { LibraryServiceOpenOptions } from './libraryServiceClient';
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
  LibrarySessionStatus,
  LibraryTask,
  LibraryTaskResult,
  LibraryVersion,
} from './libraryServiceProtocol';

const version: LibraryVersion = {
  instance: 'bench-worker',
  generation: 'bench-generation',
  revision: 1,
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Models the measured ordering: Home and Settings answer first; ancillary capability views trail them. */
class StartupClient implements LibraryServiceClientPort {
  async open(_options: LibraryServiceOpenOptions): Promise<LibraryVersion> {
    return version;
  }

  async subscribe(
    selection: LibrarySelection,
    listener: (value: LibrarySelectionValue, version: LibraryVersion) => void,
  ): Promise<() => void> {
    const ms =
      selection.kind === 'overview'
        ? 1
        : selection.kind === 'continue'
          ? 3
          : selection.kind === 'settings'
            ? 4
            : 12;
    await delay(ms);
    listener({ kind: selection.kind } as LibrarySelectionValue, version);
    return () => {};
  }

  command(_command: LibraryCommand): Promise<LibraryServiceCommandResult> {
    throw new Error('unused');
  }

  query(_query: LibraryQuery): Promise<{ result: LibraryQueryResult; version: LibraryVersion }> {
    throw new Error('unused');
  }

  task(_task: LibraryTask): Promise<{ result: LibraryTaskResult; version: LibraryVersion }> {
    throw new Error('unused');
  }

  observe(_observation: LibraryObservation): Promise<LibraryVersion> {
    throw new Error('unused');
  }

  onStatus(_listener: (status: LibrarySessionStatus) => void): () => void {
    return () => {};
  }

  close(): void {}
}

const selections = ['overview', 'continue', 'devices', 'settings', 'runtime'] as const;
const options: LibraryServiceOpenOptions = { libraryKey: 'bench-library', mode: 'online' };

async function open(backgroundCapabilities: boolean): Promise<void> {
  const supervisor = new LibraryServiceSupervisor(() => new StartupClient());
  for (const kind of selections)
    supervisor.subscribeSnapshot(
      { kind },
      () => {},
      backgroundCapabilities && (kind === 'devices' || kind === 'runtime')
        ? { readiness: 'background' }
        : undefined,
    );
  await supervisor.open(options);
  supervisor.close();
}

test('Home and Settings do not inherit ancillary capability latency', async ({ bench }) => {
  const frontier = bench('Home plus Settings frontier', async () => open(true));
  const allRoots = bench('all eager roots barrier', async () => open(false));
  const results = await bench.compare(frontier, allRoots, {
    iterations: 25,
    time: 0,
    warmup: false,
  });
  const ready = results.get('Home plus Settings frontier');
  const all = results.get('all eager roots barrier');
  console.log(
    `LIBRARY_READINESS_BENCH ${JSON.stringify({ homeAndSettingsMs: ready.latency.mean, allRootsMs: all.latency.mean })}`,
  );
  expect(ready.latency.mean).toBeLessThan(all.latency.mean / 2);
});
