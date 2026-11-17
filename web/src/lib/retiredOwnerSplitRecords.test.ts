import { describe, expect, it, vi } from 'vitest';
import type { Vault, VaultChange } from './localVault';
import { purgeRetiredOwnerSplitRecords } from './retiredOwnerSplitRecords';

const LIBRARY_A = 'a'.repeat(32);
const LIBRARY_B = 'b'.repeat(32);
const candidate = (library: string, digit: string) =>
  `${library}:profile-migration/v1/candidate/${digit.repeat(64)}`;

function memoryVault(initial: readonly string[] = []) {
  const data = new Map<string, Uint8Array>(
    initial.map((key, index) => [key, Uint8Array.of(index + 1)]),
  );
  let failCommit = false;
  const commits: VaultChange[][] = [];
  const vault: Vault = {
    get: vi.fn(async (key: string) => data.get(key)),
    entries: vi.fn(async () => {
      throw new Error('production cleanup must not read retired values');
    }),
    page: vi.fn(async (prefix: string, after: string | undefined, limit: number) =>
      [...data]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
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

    await expect(purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A)).resolves.toBeNull();

    expect([...memory.data.keys()].sort()).toEqual(
      [current, malformed, other, `${LIBRARY_A}:retired/m1`].sort(),
    );
    expect(memory.vault.entries).not.toHaveBeenCalled();
    expect(memory.commits).toHaveLength(1);
  });

  it('uses a durable receipt for absent and already-cleaned libraries', async () => {
    const memory = memoryVault();
    await expect(purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A)).resolves.toBeNull();
    await expect(purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A)).resolves.toBeNull();

    expect(memory.vault.page).toHaveBeenCalledTimes(1);
    expect(memory.commits).toHaveLength(1);
  });

  it('does not let a malformed receipt suppress cleanup', async () => {
    const state = `${LIBRARY_A}:profile-migration/v1/state`;
    const receipt = `${LIBRARY_A}:retired/m1`;
    const memory = memoryVault([state, receipt]);
    memory.data.set(receipt, Uint8Array.of(2));

    await expect(purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A)).resolves.toBeNull();
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
    const after = await purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A);
    expect(after).toBeTypeOf('string');
    expect(memory.data.has(records[64]!)).toBe(true);
    expect(memory.data.has(`${LIBRARY_A}:retired/m1`)).toBe(false);
    await expect(
      purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A, after!),
    ).resolves.toBeNull();
    expect(records.some((key) => memory.data.has(key))).toBe(false);
  });

  it('does not mark a failed pass complete', async () => {
    const state = `${LIBRARY_A}:profile-migration/v1/state`;
    const memory = memoryVault([state]);
    memory.failNextCommit();
    await expect(purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A)).rejects.toThrow();
    expect(memory.data.has(state)).toBe(true);
    expect(memory.data.has(`${LIBRARY_A}:retired/m1`)).toBe(false);
    await expect(purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A)).resolves.toBeNull();
    expect(memory.data.has(state)).toBe(false);
  });

  it('keeps completion independent for libraries on the same origin', async () => {
    const first = candidate(LIBRARY_A, '1');
    const second = candidate(LIBRARY_B, '2');
    const memory = memoryVault([first, second]);

    await purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_A);
    expect(memory.data.has(first)).toBe(false);
    expect(memory.data.has(second)).toBe(true);
    await purgeRetiredOwnerSplitRecords(memory.vault, LIBRARY_B);
    expect(memory.data.has(second)).toBe(false);
  });
});
