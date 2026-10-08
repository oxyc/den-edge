import { expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import { LibraryAdminAuthority } from './libraryAdminAuthority';
import { successorTag, type LibraryLog, type Moving } from './log';
import type { Vault } from './localVault';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const DESTINATION = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const moving: Moving = {
  rows: [],
  kept: [],
  head: 4,
  generation: 'generation-1',
  device: '0123456789abcdef',
};

const clock: ClockStore = {
  device: '0123456789abcdef',
  issue: async () => [10, 0, '0123456789abcdef'],
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
    takeMoved: vi.fn(async () => true),
    forget: vi.fn(async () => true),
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
    authority.task({ kind: 'key-reset.move', destinationLibraryKey: DESTINATION }),
  ).resolves.toEqual({
    result: { kind: 'key-reset.move', outcome: 'moved' },
    affected: [],
  });
  expect(next.takeMoved).toHaveBeenCalledWith(moving, 'member-proof');
  expect(log.endMoved).toHaveBeenCalledWith(moving, next);
  expect(log.rekeyKept).toHaveBeenCalledWith(next);
  expect(next.forget).not.toHaveBeenCalled();
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
