import { beforeEach, expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import type { LibraryLog } from './log';
import type { Vault } from './localVault';

const recovery = vi.hoisted(() => ({
  begin: vi.fn(),
  confirm: vi.fn(),
  done: vi.fn(),
  resumeMaking: vi.fn(() => vi.fn()),
  reconcile: vi.fn(async () => null),
}));

vi.mock('./recovery', () => ({
  abandon: vi.fn(async () => undefined),
  begin: recovery.begin,
  confirm: recovery.confirm,
  makingWaits: vi.fn(() => false),
  reconcile: recovery.reconcile,
  resumeMaking: recovery.resumeMaking,
  seal: vi.fn(),
  turnOff: vi.fn(async () => true),
}));

import { LibraryAdminAuthority } from './libraryAdminAuthority';

const clock: ClockStore = {
  device: '0123456789abcdef',
  issue: async () => [1, 0, '0123456789abcdef'],
  historical: async (times) => times.map((at, index) => [at, index + 1, '0123456789abcdef']),
  see: async () => {},
  current: async () => [1, 0, '0123456789abcdef'],
};

const vault = {
  get: async () => undefined,
  entries: async () => [],
  put: async () => {},
  delete: async () => {},
  remove: async () => {},
} satisfies Vault;

beforeEach(() => {
  vi.clearAllMocks();
  recovery.begin.mockResolvedValue({
    ok: true,
    baseLive: new Set(['previous-live']),
    done: recovery.done,
  });
  recovery.confirm.mockResolvedValue({ ok: true });
});

it('restores a begun recovery transaction after authority replacement', async () => {
  const kept = new Map<string, unknown>();
  const log = {
    libraryId: 'library-id',
    memberProof: 'member-proof',
    newestStamp: () => [0, 0, ''] as [number, number, string],
    kept: async <T>(name: string) => structuredClone(kept.get(name)) as T | undefined,
    keep: async (name: string, value: unknown) => void kept.set(name, structuredClone(value)),
  } as unknown as LibraryLog;
  const options = {
    mode: 'online' as const,
    libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    vault,
  };
  const first = new LibraryAdminAuthority(log, clock, options);
  await expect(
    first.task(
      {
        kind: 'recovery.begin',
        locator: 'a'.repeat(32),
        sealed: 'sealed',
        createdAt: 10,
      },
      'begin-1',
    ),
  ).resolves.toMatchObject({ result: { outcome: 'begun' } });
  first.close();

  const replacement = new LibraryAdminAuthority(log, clock, options);
  await replacement.recoveryView();
  expect(recovery.resumeMaking).toHaveBeenCalledWith(expect.anything(), 'a'.repeat(32));
  expect(recovery.resumeMaking.mock.invocationCallOrder[0]).toBeLessThan(
    recovery.reconcile.mock.invocationCallOrder[0]!,
  );
  await expect(
    replacement.task({ kind: 'recovery.confirm', locator: 'a'.repeat(32) }, 'confirm-1'),
  ).resolves.toMatchObject({ result: { outcome: 'confirmed' } });
  expect(recovery.begin).toHaveBeenCalledOnce();
  expect(recovery.confirm).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ locator: 'a'.repeat(32), sealed: 'sealed', createdAt: 10 }),
    new Set(['previous-live']),
  );

  replacement.close();
  const afterLostReply = new LibraryAdminAuthority(log, clock, options);
  await expect(
    afterLostReply.task({ kind: 'recovery.confirm', locator: 'a'.repeat(32) }, 'confirm-1'),
  ).resolves.toMatchObject({ result: { outcome: 'confirmed' } });
  expect(recovery.confirm).toHaveBeenCalledOnce();
});
