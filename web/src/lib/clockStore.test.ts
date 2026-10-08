import { describe, expect, it } from 'vitest';
import { openClockStore } from './clockStore';
import type { Vault } from './localVault';
import { compareStamps } from './wire';

function memoryVault() {
  const values = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const vault: Vault = {
    get: async (key) => values.get(key)?.slice(),
    entries: async (prefix) =>
      [...values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value.slice()]),
    put: async (key, value) => {
      writes.push(key);
      values.set(key, value.slice());
    },
    delete: async (key) => void values.delete(key),
    remove: async (prefix) => {
      for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
    },
  };
  return { values, vault, writes };
}

describe('openClockStore', () => {
  it('imports the legacy clock once, then uses only durable state', async () => {
    const memory = memoryVault();
    const first = await openClockStore(memory.vault, {
      legacy: { device: '0123456789abcdef', last: [90_000, 4, 'other'] },
    });
    expect(first.device).toBe('0123456789abcdef');
    expect(await first.issue(1_000)).toEqual([90_000, 5, '0123456789abcdef']);

    const reopened = await openClockStore(memory.vault, {
      legacy: { device: 'ffffffffffffffff', last: [999_999, 9, 'ignored'] },
    });
    expect(reopened.device).toBe('0123456789abcdef');
    expect(await reopened.issue(500)).toEqual([90_000, 6, '0123456789abcdef']);
    expect(memory.writes).toHaveLength(3);
  });

  it('serializes concurrent issue and see operations without losing their order', async () => {
    const memory = memoryVault();
    const clock = await openClockStore(memory.vault, {
      createDevice: () => '0123456789abcdef',
    });

    const first = clock.issue(5_000);
    const seen = clock.see([8_000, 2, 'remote']);
    const third = clock.issue(1_000);
    expect(await first).toEqual([5_000, 0, '0123456789abcdef']);
    await seen;
    expect(await third).toEqual([8_000, 3, '0123456789abcdef']);
    expect(await clock.current()).toEqual([8_000, 3, '0123456789abcdef']);
  });

  it('does not expose a state that failed to become durable, and keeps the queue usable', async () => {
    const memory = memoryVault();
    const clock = await openClockStore(memory.vault, {
      createDevice: () => '0123456789abcdef',
    });
    const put = memory.vault.put;
    let fail = true;
    memory.vault.put = async (key, value) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      await put(key, value);
    };

    await expect(clock.issue(4_000)).rejects.toThrow('disk full');
    expect(await clock.current()).toEqual([0, 0, '']);
    const retry = await clock.issue(4_000);
    expect(retry).toEqual([4_000, 0, '0123456789abcdef']);

    const reopened = await openClockStore(memory.vault);
    expect(compareStamps(await reopened.current(), retry)).toBe(0);
  });
});
