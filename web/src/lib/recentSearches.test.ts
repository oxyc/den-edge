import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRecentSearches,
  forgetSearch,
  isRecentSearchStorageEvent,
  readRecentSearches,
  rememberSearch,
  scopeRecentSearches,
} from './recentSearches';

const storage = (initial: Record<string, string> = {}): Storage => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, next) => values.set(key, next)),
    removeItem: vi.fn((key) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  };
};

describe('recent searches', () => {
  let testScope = 0;
  beforeEach(() => scopeRecentSearches(true, 'test-household', `owner-${++testScope}`));

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
    const malformed = storage();
    malformed.setItem = vi.fn();
    malformed.getItem = vi.fn(() => '{');
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

  it('isolates exact household Owners and memory-only profile sessions', () => {
    const saved = storage({ 'den.recentSearches': JSON.stringify(['Legacy search']) });
    vi.stubGlobal('localStorage', saved);
    try {
      scopeRecentSearches(true, 'household-a-secret', 'owner-a');
      expect(readRecentSearches()).toEqual([]);
      expect(saved.removeItem).toHaveBeenCalledWith('den.recentSearches');
      rememberSearch('Owner A search');
      const ownerAKey = vi.mocked(saved.setItem).mock.calls.at(-1)?.[0];
      expect(ownerAKey).toMatch(/^den\.recentSearches\.v2:/);
      expect(ownerAKey).not.toContain('household-a-secret');
      expect(ownerAKey).not.toContain('owner-a');

      scopeRecentSearches(false, 'household-a-secret', 'kid-a');
      expect(readRecentSearches()).toEqual([]);
      expect(rememberSearch('Kid A cartoons')).toEqual(['Kid A cartoons']);

      scopeRecentSearches(false, 'household-a-secret', 'kid-b');
      expect(readRecentSearches()).toEqual([]);
      expect(rememberSearch('Kid B cartoons')).toEqual(['Kid B cartoons']);

      scopeRecentSearches(false, 'household-a-secret', 'visitor-1');
      expect(readRecentSearches()).toEqual([]);
      expect(rememberSearch('Visitor search')).toEqual(['Visitor search']);

      scopeRecentSearches(false, 'household-a-secret', 'visitor-2');
      expect(readRecentSearches()).toEqual([]);

      scopeRecentSearches(true, 'household-a-secret', 'replacement-owner');
      expect(readRecentSearches()).toEqual([]);

      scopeRecentSearches(true, 'household-b-secret', 'owner-b');
      expect(readRecentSearches()).toEqual([]);
      rememberSearch('Owner B search');
      expect(forgetSearch('Owner A search')).toEqual(['Owner B search']);
      expect(clearRecentSearches()).toEqual([]);

      scopeRecentSearches(true, 'household-a-secret', 'owner-a');
      expect(readRecentSearches()).toEqual(['Owner A search']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows only the active authority key and whole-storage clears from another tab', () => {
    const kept = storage();
    vi.stubGlobal('localStorage', kept);
    scopeRecentSearches(true, 'household-a', 'owner-a');
    rememberSearch('Arrival');
    const activeKey = vi
      .mocked(kept.setItem)
      .mock.calls.find(([key]) => key.startsWith('den.recentSearches.v2:'))?.[0];
    expect(isRecentSearchStorageEvent({ key: activeKey } as StorageEvent)).toBe(true);
    expect(isRecentSearchStorageEvent({ key: null } as StorageEvent)).toBe(true);
    scopeRecentSearches(true, 'household-b', 'owner-b');
    expect(isRecentSearchStorageEvent({ key: activeKey } as StorageEvent)).toBe(false);
    expect(isRecentSearchStorageEvent({ key: 'den.recentSearches' } as StorageEvent)).toBe(false);
    expect(isRecentSearchStorageEvent({ key: 'something.else' } as StorageEvent)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('does not create retained state merely by opening an Owner scope', () => {
    const kept = storage();
    vi.stubGlobal('localStorage', kept);
    scopeRecentSearches(true, 'unsearched-household', 'owner');
    expect(kept.getItem('den.recentSearches.v2.scopes')).toBeNull();
    expect(kept.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('bounds retained opaque Owner namespaces', () => {
    const kept = storage();
    vi.stubGlobal('localStorage', kept);
    scopeRecentSearches(true, 'household-0-secret', 'owner-0');
    rememberSearch('First household search');
    const firstKey = vi
      .mocked(kept.setItem)
      .mock.calls.find(([key]) => key.startsWith('den.recentSearches.v2:'))?.[0];
    expect(firstKey).toBeDefined();

    for (let index = 1; index <= 8; index++) {
      scopeRecentSearches(true, `household-${index}-secret`, `owner-${index}`);
      rememberSearch(`Household ${index} search`);
    }

    expect(kept.getItem(firstKey!)).toBeNull();
    const scopes = kept.getItem('den.recentSearches.v2.scopes');
    expect(scopes!.split(',')).toHaveLength(8);
    expect(scopes).not.toContain('household-');
    expect(scopes).not.toContain('owner-');

    // A still-open tab can write after another tab evicted its namespace. The explicit write must reclaim a bounded
    // registry slot instead of leaving untracked plaintext behind.
    const activeKey = vi
      .mocked(kept.setItem)
      .mock.calls.filter(([key]) => key.startsWith('den.recentSearches.v2:'))
      .at(-1)?.[0];
    const remoteScopes = Array.from({ length: 8 }, (_, index) =>
      index.toString(16).padStart(16, '0'),
    );
    kept.setItem('den.recentSearches.v2.scopes', remoteScopes.join());
    kept.removeItem(activeKey!);
    rememberSearch('Still active tab search');
    expect(kept.getItem('den.recentSearches.v2.scopes')!.split(',')).toEqual([
      activeKey!.split(':').at(-1),
      ...remoteScopes.slice(0, 7),
    ]);
    vi.unstubAllGlobals();
  });
});
