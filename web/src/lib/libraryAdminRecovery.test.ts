import { beforeEach, expect, it, vi } from 'vitest';
import type { ClockStore } from './clockStore';
import type { LibraryLog } from './log';
import type { Vault } from './localVault';

const recovery = vi.hoisted(() => ({
  begin: vi.fn(),
  confirm: vi.fn(),
  abandonPending: vi.fn(
    async (): Promise<'abandoned' | 'confirmed' | 'lost' | 'failed'> => 'abandoned',
  ),
  done: vi.fn(),
  resumeMaking: vi.fn(() => vi.fn()),
  reconcile: vi.fn(async () => null),
}));

vi.mock('./recovery', () => ({
  abandon: vi.fn(async () => undefined),
  abandonPending: recovery.abandonPending,
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

it('stops reconciling recovery with a member proof den-edge refused', async () => {
  const log = {
    libraryId: 'library-id',
    memberProof: 'member-proof',
    newestStamp: () => [0, 0, ''] as [number, number, string],
    kept: async () => undefined,
    keep: async () => {},
  } as unknown as LibraryLog & { memberProof: string };
  // den-edge answering 403, as `recovery.ts`'s own call reports it.
  recovery.reconcile.mockImplementation(async (...args: unknown[]) => {
    (args[0] as { refused?: () => void }).refused?.();
    return null;
  });
  const admin = new LibraryAdminAuthority(log, clock, {
    mode: 'online',
    libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    vault,
  });
  // Settings reselects the view on every library change while it is open.
  for (let change = 0; change < 5; change++) await admin.recoveryView();
  expect(recovery.reconcile).toHaveBeenCalledOnce();
  // A new proof (a key reset, a repaired membership) is asked again.
  log.memberProof = 'another-proof';
  await admin.recoveryView();
  expect(recovery.reconcile).toHaveBeenCalledTimes(2);
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

it('serializes teardown cleanup behind confirmation and preserves the committed code', async () => {
  const kept = new Map<string, unknown>();
  const log = {
    libraryId: 'library-id',
    memberProof: 'member-proof',
    newestStamp: () => [0, 0, ''] as [number, number, string],
    kept: async <T>(name: string) => structuredClone(kept.get(name)) as T | undefined,
    keep: async (name: string, value: unknown) => void kept.set(name, structuredClone(value)),
  } as unknown as LibraryLog;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  recovery.confirm.mockImplementationOnce(async () => {
    await held;
    return { ok: true };
  });
  const admin = new LibraryAdminAuthority(log, clock, {
    mode: 'online',
    libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    vault,
  });
  const locator = 'b'.repeat(32);
  await admin.task(
    { kind: 'recovery.begin', locator, sealed: 'sealed', createdAt: 10 },
    'begin-held',
  );
  const confirming = admin.task({ kind: 'recovery.confirm', locator }, 'confirm-held');
  await vi.waitFor(() => expect(recovery.confirm).toHaveBeenCalledOnce());
  const cleanup = admin.task({ kind: 'recovery.abandon', locator }, 'cleanup-held');
  expect(recovery.abandonPending).not.toHaveBeenCalled();
  release();
  await expect(confirming).resolves.toMatchObject({ result: { outcome: 'confirmed' } });
  await expect(cleanup).resolves.toMatchObject({ result: { outcome: 'confirmed' } });
  expect(recovery.abandonPending).not.toHaveBeenCalled();

  await admin.close();
  const replacement = new LibraryAdminAuthority(log, clock, {
    mode: 'online',
    libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    vault,
  });
  await expect(
    replacement.task({ kind: 'recovery.confirm', locator }, 'confirm-held'),
  ).resolves.toMatchObject({ result: { outcome: 'confirmed' } });
  expect(recovery.confirm).toHaveBeenCalledOnce();
});

it('keeps a failed teardown cleanup pending without retaining its make heartbeat', async () => {
  const kept = new Map<string, unknown>();
  const log = {
    libraryId: 'library-id',
    memberProof: 'member-proof',
    newestStamp: () => [0, 0, ''] as [number, number, string],
    kept: async <T>(name: string) => structuredClone(kept.get(name)) as T | undefined,
    keep: async (name: string, value: unknown) => void kept.set(name, structuredClone(value)),
  } as unknown as LibraryLog;
  recovery.abandonPending.mockResolvedValueOnce('failed');
  const admin = new LibraryAdminAuthority(log, clock, {
    mode: 'online',
    libraryKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    vault,
  });
  const locator = 'c'.repeat(32);
  await admin.task(
    { kind: 'recovery.begin', locator, sealed: 'sealed', createdAt: 10 },
    'begin-failed-cleanup',
  );
  await expect(
    admin.task({ kind: 'recovery.abandon', locator }, 'cleanup-failed'),
  ).resolves.toMatchObject({ result: { outcome: 'failed' } });
  expect(recovery.done).toHaveBeenCalledOnce();
  await admin.close();
  expect(recovery.done).toHaveBeenCalledOnce();
});
