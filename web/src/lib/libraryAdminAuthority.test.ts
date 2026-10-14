import { expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import { LibraryAdminAuthority } from './libraryAdminAuthority';
import { LibraryLog, successorTag, type Moving } from './log';
import type { Vault } from './localVault';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const DESTINATION = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const moving: Moving = {
  rows: [],
  kept: [],
  head: 4,
  generation: 'generation-1',
  device: '0123456789abcdef',
  revokedGrants: [],
};

const clock: ClockStore = {
  device: '0123456789abcdef',
  issue: async () => [10, 0, '0123456789abcdef'],
  historical: async (times) => times.map((at, index) => [at, index + 1, '0123456789abcdef']),
  see: async () => {},
  current: async () => [10, 0, '0123456789abcdef'],
};

const vault: Vault = {
  get: async () => undefined,
  entries: async () => [],
  put: async () => {},
  delete: async () => {},
  remove: async () => {},
};

it('moves a library through one authority-owned cursor and rekeys its kept state', async () => {
  const next = {
    libraryId: 'destination-library',
    takeMoved: vi.fn(async () => true),
    forget: vi.fn(async () => true),
    kept: vi.fn(async () => undefined),
    keep: vi.fn(async () => undefined),
  };
  const log = {
    memberProof: 'member-proof',
    moving: vi.fn(async () => moving),
    endMoved: vi.fn(async () => 'deleted' as const),
    rekeyKept: vi.fn(async () => {}),
  };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
    destination: async () => next as unknown as LibraryLog,
  });

  await expect(
    authority.task({ kind: 'key-reset.move', destinationLibraryKey: DESTINATION }, 'move-1'),
  ).resolves.toEqual({
    result: { kind: 'key-reset.move', outcome: 'moved' },
    affected: [],
  });
  expect(next.takeMoved).toHaveBeenCalledWith(moving, 'member-proof');
  expect(log.endMoved).toHaveBeenCalledWith(moving, next);
  expect(log.rekeyKept).toHaveBeenCalledWith(next);
  expect(next.keep).toHaveBeenCalledWith(
    'library-service-operations.v2',
    expect.arrayContaining([expect.objectContaining({ operationId: 'move-1', state: 'complete' })]),
  );
  expect(next.forget).not.toHaveBeenCalled();
});

it('reports a profile-aware refusal without writing the destination or retiring the library', async () => {
  const next = {
    libraryId: 'destination-library',
    takeMoved: vi.fn(async () => true),
    forget: vi.fn(async () => true),
  };
  const log = {
    memberProof: 'member-proof',
    moving: vi.fn(async () => ({ refused: 'profiles' as const })),
    endMoved: vi.fn(async () => 'deleted' as const),
    rekeyKept: vi.fn(async () => {}),
  };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
    destination: async () => next as unknown as LibraryLog,
  });

  await expect(
    authority.task({ kind: 'key-reset.move', destinationLibraryKey: DESTINATION }, 'move-1'),
  ).resolves.toEqual({
    result: { kind: 'key-reset.move', outcome: 'profiles-active' },
    affected: [],
  });
  expect(next.takeMoved).not.toHaveBeenCalled();
  expect(log.endMoved).not.toHaveBeenCalled();
  expect(log.rekeyKept).not.toHaveBeenCalled();
  expect(next.forget).toHaveBeenCalledOnce();
});

it('settles only the destination named by the retired library', async () => {
  const next = {
    libraryId: 'destination-library',
    forget: vi.fn(async () => true),
  };
  const log = {
    standing: vi.fn(async () => ({ moved: true, successor: await successorTag(next.libraryId) })),
    rekeyKept: vi.fn(async () => {}),
  };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
    destination: async () => next as unknown as LibraryLog,
  });

  await expect(
    authority.task({ kind: 'key-reset.settle', destinationLibraryKey: DESTINATION }),
  ).resolves.toMatchObject({ result: { outcome: 'adopted' } });
  expect(log.rekeyKept).toHaveBeenCalledWith(next);
  expect(next.forget).not.toHaveBeenCalled();
});

it('merges only a distinct registered browser-local source into an online target', async () => {
  const source = {
    rows: vi.fn(() => [{ kind: 'set', schema: 2, name: 'prefs', values: {} }]),
    forget: vi.fn(async () => true),
    close: vi.fn(),
  };
  const existing = vi
    .spyOn(LibraryLog, 'openExistingLocal')
    .mockResolvedValueOnce(source as unknown as LibraryLog);
  const kept = new Map<string, unknown>();
  const log = {
    writeRows: vi.fn(async () => true),
    kept: async <T>(name: string) => structuredClone(kept.get(name)) as T | undefined,
    keep: async (name: string, value: unknown) => void kept.set(name, structuredClone(value)),
  };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
  });

  await expect(
    authority.task({ kind: 'local-library.merge', sourceLibraryKey: DESTINATION }, 'merge-1'),
  ).resolves.toEqual({
    result: { kind: 'local-library.merge', outcome: 'merged' },
    affected: expect.any(Array),
  });
  expect(existing).toHaveBeenCalledWith(DESTINATION, vault);
  expect(log.writeRows).toHaveBeenCalledWith(source.rows());
  expect(source.forget).toHaveBeenCalledOnce();
  expect(source.close).toHaveBeenCalledOnce();

  await expect(
    authority.task({ kind: 'local-library.merge', sourceLibraryKey: DESTINATION }, 'merge-1'),
  ).resolves.toMatchObject({ result: { outcome: 'merged' } });
  expect(log.writeRows).toHaveBeenCalledOnce();

  await expect(
    authority.task({ kind: 'local-library.merge', sourceLibraryKey: KEY }),
  ).resolves.toEqual({
    result: { kind: 'local-library.merge', outcome: 'unavailable' },
    affected: [],
  });
  expect(existing).toHaveBeenCalledTimes(2);
});

it('keeps the source until den-edge, read back, holds everything moved', async () => {
  const watchlisted = {
    kind: 'rec',
    schema: 2,
    title: { type: 'movie', id: 1 },
    status: { value: 'watchlist', at: [1000, 0, 'aaaaaaaaaaaaaaaa'] },
    resume: { value: 0, at: [0, 0, ''], viewing: 0 },
    reaction: { value: null, at: [0, 0, ''] },
    deleted: { value: false, at: [0, 0, ''] },
    dismissed: { value: false, at: [0, 0, ''] },
    episodesReset: null,
    addedAt: 1000,
    watchedAt: null,
  };
  const source = {
    rows: vi.fn(() => [watchlisted]),
    forget: vi.fn(async () => true),
    close: vi.fn(),
  };
  vi.spyOn(LibraryLog, 'openExistingLocal').mockResolvedValue(source as unknown as LibraryLog);
  const held: unknown[] = [];
  const log = {
    writeRows: vi.fn(async () => true),
    heldRows: vi.fn(async () => held),
    retryAfterMs: 0,
  };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
  });
  const merge = () =>
    authority.task({
      kind: 'local-library.merge',
      sourceLibraryKey: DESTINATION,
      scope: 'profile',
      verify: true,
    });

  await expect(merge()).resolves.toMatchObject({ result: { outcome: 'unverified' } });
  expect(source.forget).not.toHaveBeenCalled();

  held.push(watchlisted);
  await expect(merge()).resolves.toMatchObject({ result: { outcome: 'merged' } });
  expect(source.forget).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});

it('stops writing a move in batches once den-edge asks it to wait, and says how long', async () => {
  const rows = Array.from({ length: 250 }, (_, id) => ({
    kind: 'set',
    schema: 2,
    name: `extra-${id}`,
    values: {},
  }));
  const source = { rows: vi.fn(() => rows), forget: vi.fn(async () => true), close: vi.fn() };
  vi.spyOn(LibraryLog, 'openExistingLocal').mockResolvedValue(source as unknown as LibraryLog);
  const log = {
    // A refused edit is kept, so the batch still answers true; the wait is what tells.
    writeRows: vi.fn(async (_rows: unknown[]) => {
      log.retryAfterMs = 3000;
      return true;
    }),
    heldRows: vi.fn(async () => []),
    retryAfterMs: 0,
  };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
  });

  await expect(
    authority.task({ kind: 'local-library.merge', sourceLibraryKey: DESTINATION, verify: true }),
  ).resolves.toMatchObject({ result: { outcome: 'unavailable', retryAfterMs: 3000 } });
  expect(log.writeRows).toHaveBeenCalledOnce();
  expect(log.writeRows.mock.calls[0]![0]).toHaveLength(100);
  expect(source.forget).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('rejects a source key that has no browser-local library', async () => {
  const existing = vi.spyOn(LibraryLog, 'openExistingLocal').mockResolvedValueOnce(null);
  const log = { writeRows: vi.fn(async () => true) };
  const authority = new LibraryAdminAuthority(log as unknown as LibraryLog, clock, {
    mode: 'online',
    libraryKey: KEY,
    vault,
  });

  await expect(
    authority.task({ kind: 'local-library.merge', sourceLibraryKey: DESTINATION }),
  ).resolves.toEqual({
    result: { kind: 'local-library.merge', outcome: 'absent' },
    affected: [],
  });
  expect(existing).toHaveBeenCalledWith(DESTINATION, vault);
  expect(log.writeRows).not.toHaveBeenCalled();
});
