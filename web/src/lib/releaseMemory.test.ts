import { describe, expect, it, vi } from 'vitest';
import { recallReleases, rememberReleases } from './releaseMemory';

function memoryStore(): Storage {
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
}

describe('releaseMemory', () => {
  it('keeps the viewer’s pick and the releases left, per title and episode', () => {
    const store = memoryStore();
    rememberReleases('tv:1:1:3', { chosen: 'b.mkv', left: ['a.mkv'] }, store);
    expect(recallReleases('tv:1:1:3', store)).toEqual({ chosen: 'b.mkv', left: ['a.mkv'] });
    expect(recallReleases('tv:1:1:4', store)).toEqual({ chosen: undefined, left: [] });
  });

  it('reads nothing it didn’t write, and nothing from a store it can’t use', () => {
    const store = memoryStore();
    store.setItem('den.releases.x', '{"chosen":3,"left":["a.mkv",4]}');
    expect(recallReleases('x', store)).toEqual({ chosen: undefined, left: ['a.mkv'] });
    store.setItem('den.releases.y', 'not json');
    expect(recallReleases('y', store)).toEqual({ left: [] });
    expect(recallReleases('z', undefined)).toEqual({ chosen: undefined, left: [] });
  });

  it('says so when the store refuses a write, and carries on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memoryStore();
    store.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => rememberReleases('x', { left: [] }, store)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
