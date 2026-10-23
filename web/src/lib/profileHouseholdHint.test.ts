import { describe, expect, it } from 'vitest';
import { knownProfileHousehold, rememberProfileHousehold } from './profileHouseholdHint';

const HINT_KEY = 'den.household.wire5.v1';

function memory(initial: string[] = []): Storage {
  const values = new Map([[HINT_KEY, JSON.stringify(initial)]]);
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('profile household hint', () => {
  it('retains the exact persisted FNV-1a tags produced by the former BigInt implementation', () => {
    const vectors = [
      ['', 'fe148a88a5dafc49'],
      ['a', '97e38e31d31a77f8'],
      ['library-1', '152e6ed14ad035de'],
      ['YWJjZA==', 'f2d164e0e5686dc2'],
      ['0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/=', '5459025f914b5073'],
    ] as const;

    for (const [key, existingTag] of vectors) {
      expect(knownProfileHousehold(key, memory([existingTag]))).toBe(true);
      const storage = memory();
      rememberProfileHousehold(key, storage);
      expect(storage.getItem(HINT_KEY)).toBe(JSON.stringify([existingTag]));
    }
  });
});
