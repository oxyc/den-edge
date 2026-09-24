import { describe, expect, it } from 'vitest';
import { keepProfile, keptProfile } from '../../cast/src/profile';

const memory = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (n) => [...items.keys()][n] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
};

describe('the cast page’s receiver profile', () => {
  it('remembers the profile chosen, under its current name', () => {
    const storage = memory();
    expect(keptProfile(storage)).toBeNull();
    keepProfile('streamer', storage);
    expect(keptProfile(storage)).toBe('streamer');
    keepProfile('google-tv', storage);
    expect(keptProfile(storage), 'the old name for the 4K Google TV').toBe('google-tv-4k');
  });

  it('reads nothing, and throws nothing, where storage throws', () => {
    const refusing = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    } as unknown as Storage;
    expect(keptProfile(refusing)).toBeNull();
    expect(() => keepProfile('streamer', refusing)).not.toThrow();
  });

  it('reads nothing where merely touching localStorage throws, as in a storage-blocked frame', () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(keptProfile()).toBeNull();
      expect(() => keepProfile('streamer')).not.toThrow();
    } finally {
      if (was) Object.defineProperty(globalThis, 'localStorage', was);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
