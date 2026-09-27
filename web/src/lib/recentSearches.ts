const STORAGE_KEY = 'den.recentSearches';
const LIMIT = 8;
const MAX_QUERY_LENGTH = 200;
let memory: string[] = [];

export const RECENT_SEARCHES_CHANGED = 'den:recent-searches-changed';

const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
const browserStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** This browser's recent explicit title searches, newest first. */
export function readRecentSearches(storage: Storage | undefined = browserStorage()): string[] {
  if (!storage) return memory;
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map(clean)
      .filter((value) => {
        const key = value.toLocaleLowerCase();
        if (value.length < 2 || value.length > MAX_QUERY_LENGTH || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, LIMIT);
  } catch {
    return memory;
  }
}

function changed(searches: string[]): void {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
  globalThis.dispatchEvent(new CustomEvent(RECENT_SEARCHES_CHANGED, { detail: searches }));
}

function write(searches: string[], storage: Storage | undefined): string[] {
  memory = searches;
  try {
    if (searches.length) storage?.setItem(STORAGE_KEY, JSON.stringify(searches));
    else storage?.removeItem(STORAGE_KEY);
  } catch {
    // The list still works for this visit when storage is blocked.
  }
  changed(searches);
  return searches;
}

/** Keep an explicit search, deduplicated without changing the user's casing. */
export function rememberSearch(
  query: string,
  storage: Storage | undefined = browserStorage(),
): string[] {
  const value = clean(query);
  if (value.length < 2 || value.length > MAX_QUERY_LENGTH) return readRecentSearches(storage);
  const key = value.toLocaleLowerCase();
  return write(
    [
      value,
      ...readRecentSearches(storage).filter((recent) => recent.toLocaleLowerCase() !== key),
    ].slice(0, LIMIT),
    storage,
  );
}

export function forgetSearch(
  query: string,
  storage: Storage | undefined = browserStorage(),
): string[] {
  const key = clean(query).toLocaleLowerCase();
  return write(
    readRecentSearches(storage).filter((recent) => recent.toLocaleLowerCase() !== key),
    storage,
  );
}

export function clearRecentSearches(storage: Storage | undefined = browserStorage()): string[] {
  return write([], storage);
}

export function isRecentSearchStorageEvent(event: StorageEvent): boolean {
  return event.key === STORAGE_KEY || event.key === null;
}
