import { describe, expect, it, vi } from 'vitest';
import type { Vault, VaultChange } from './localVault';
import { RetiredOwnerSplitRecords } from './retiredOwnerSplitRecords';

const LIBRARY_A = 'a'.repeat(32);
const LIBRARY_B = 'b'.repeat(32);
const candidate = (library: string, digit: string) =>
  `${library}:profile-migration/v1/candidate/${digit.repeat(64)}`;

function memoryVault(initial: readonly string[] = []) {
  const data = new Map(initial.map((key, index) => [key, Uint8Array.of(index + 1)]));
  let failCommit = false;
  const commits: VaultChange[][] = [];
  const vault: Vault = {
    get: vi.fn(async (key: string) => data.get(key)),
    entries: vi.fn(async () => {
      throw new Error('production cleanup must not read retired values');
    }),
    keys: vi.fn(async (prefix: string, after: string | undefined, limit: number) =>
      [...data.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort()
        .slice(0, limit),
    ),
    put: vi.fn(async (key: string, value: Uint8Array) => void data.set(key, value)),
    delete: vi.fn(async (key: string) => void data.delete(key)),
    remove: vi.fn(async () => undefined),
    commit: vi.fn(async (changes: readonly VaultChange[]) => {
      if (failCommit) {
        failCommit = false;
        throw new Error('failed storage operation containing private adapter detail');
      }
      commits.push([...changes]);
      for (const change of changes) {
        if (change.kind === 'delete') data.delete(change.key);
        else data.set(change.key, change.value);
      }
    }),
  };
  return {
    data,
    vault,
    commits,
    failNextCommit: () => (failCommit = true),
  };
}

describe('retired Owner-split browser records', () => {
  it('deletes only the exact state and valid candidate shapes for the current library', async () => {
    const state = `${LIBRARY_A}:profile-migration/v1/state`;
    const candidates = [candidate(LIBRARY_A, '1'), candidate(LIBRARY_A, '2')];
    const current = `${LIBRARY_A}:profile-create/v2/journal`;
    const malformed = `${LIBRARY_A}:profile-migration/v1/candidate/not-a-reference`;
    const other = candidate(LIBRARY_B, '3');
    const memory = memoryVault([state, ...candidates, current, malformed, other]);

    await expect(new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A).run()).resolves.toBe(true);

    expect([...memory.data.keys()].sort()).toEqual(
      [current, malformed, other, `${LIBRARY_A}:retired/profile-migration.v1`].sort(),
    );
    expect(memory.vault.entries).not.toHaveBeenCalled();
    expect(memory.commits).toHaveLength(1);
  });

  it('uses a durable receipt for absent and already-cleaned libraries', async () => {
    const memory = memoryVault();
    const first = new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A);
    await expect(first.run()).resolves.toBe(true);
    await expect(first.run()).resolves.toBe(true);
    const reopened = new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A);
    await expect(reopened.run()).resolves.toBe(true);

    expect(memory.vault.keys).toHaveBeenCalledTimes(1);
    expect(memory.commits).toHaveLength(1);
  });

  it('does not let a malformed receipt suppress cleanup', async () => {
    const state = `${LIBRARY_A}:profile-migration/v1/state`;
    const receipt = `${LIBRARY_A}:retired/profile-migration.v1`;
    const memory = memoryVault([state, receipt]);
    memory.data.set(receipt, Uint8Array.of(2));

    await expect(new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A).run()).resolves.toBe(true);
    expect(memory.data.has(state)).toBe(false);
    expect(memory.data.get(receipt)).toEqual(Uint8Array.of(1));
  });

  it('bounds each pass and resumes after the last committed key', async () => {
    const records = Array.from(
      { length: 65 },
      (_, index) =>
        `${LIBRARY_A}:profile-migration/v1/candidate/${index.toString(16).padStart(64, '0')}`,
    );
    const memory = memoryVault(records);
    const cleanup = new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A);

    await expect(cleanup.run()).resolves.toBe(false);
    expect(memory.data.has(records[64]!)).toBe(true);
    expect(memory.data.has(`${LIBRARY_A}:retired/profile-migration.v1`)).toBe(false);
    await expect(cleanup.run()).resolves.toBe(true);
    expect(records.some((key) => memory.data.has(key))).toBe(false);
  });

  it('does not mark a failed pass complete and retries without logging adapter details', async () => {
    const state = `${LIBRARY_A}:profile-migration/v1/state`;
    const memory = memoryVault([state]);
    memory.failNextCommit();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cleanup = new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A);

    await expect(cleanup.run()).resolves.toBe(false);
    expect(memory.data.has(state)).toBe(true);
    expect(memory.data.has(`${LIBRARY_A}:retired/profile-migration.v1`)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'den: retired browser migration storage cleanup will be retried',
    );
    await expect(cleanup.run()).resolves.toBe(true);
    expect(memory.data.has(state)).toBe(false);
  });

  it('keeps completion independent for libraries on the same origin', async () => {
    const first = candidate(LIBRARY_A, '1');
    const second = candidate(LIBRARY_B, '2');
    const memory = memoryVault([first, second]);

    await new RetiredOwnerSplitRecords(memory.vault, LIBRARY_A).run();
    expect(memory.data.has(first)).toBe(false);
    expect(memory.data.has(second)).toBe(true);
    await new RetiredOwnerSplitRecords(memory.vault, LIBRARY_B).run();
    expect(memory.data.has(second)).toBe(false);
  });
});
