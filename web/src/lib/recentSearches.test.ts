import { describe, expect, it, vi } from 'vitest';
import {
  clearRecentSearches,
  forgetSearch,
  isRecentSearchStorageEvent,
  readRecentSearches,
  rememberSearch,
} from './recentSearches';

const storage = (initial: string | null = null): Storage => {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key, next) => (value = next)),
    removeItem: vi.fn(() => (value = null)),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
  };
};

describe('recent searches', () => {
  it('keeps explicit searches newest first, cleaned and case-insensitively deduplicated', () => {
    const kept = storage();
    rememberSearch('  Studio   Ghibli ', kept);
    rememberSearch('Swedish movies', kept);
    expect(rememberSearch('studio ghibli', kept)).toEqual(['studio ghibli', 'Swedish movies']);
    expect(readRecentSearches(kept)).toEqual(['studio ghibli', 'Swedish movies']);
  });

  it('keeps eight useful entries and can remove one or all', () => {
    const kept = storage();
    for (let i = 0; i < 10; i++) rememberSearch(`Film ${i}`, kept);
    expect(readRecentSearches(kept)).toHaveLength(8);
    expect(forgetSearch('Film 8', kept)).not.toContain('Film 8');
    expect(clearRecentSearches(kept)).toEqual([]);
    expect(kept.removeItem).toHaveBeenCalled();
  });

  it('ignores short, malformed and inaccessible storage', () => {
    const malformed = storage('{');
    expect(readRecentSearches(malformed)).toEqual([]);
    expect(rememberSearch('x', malformed)).toEqual([]);
    expect(rememberSearch('x'.repeat(201), malformed)).toEqual([]);
    const blocked = {
      getItem: () => {
        throw Error('blocked');
      },
    } as unknown as Storage;
    expect(readRecentSearches(blocked)).toEqual([]);
    expect(() => rememberSearch('Arrival', blocked)).not.toThrow();
  });

  it('follows this key and whole-storage clears from another tab', () => {
    expect(isRecentSearchStorageEvent({ key: 'den.recentSearches' } as StorageEvent)).toBe(true);
    expect(isRecentSearchStorageEvent({ key: null } as StorageEvent)).toBe(true);
    expect(isRecentSearchStorageEvent({ key: 'something.else' } as StorageEvent)).toBe(false);
  });
});
