import { householdTag } from './profileHouseholdHint';

const LEGACY_STORAGE_KEY = 'den.recentSearches';
const STORAGE_PREFIX = 'den.recentSearches.v2';
const SCOPES_KEY = `${STORAGE_PREFIX}.scopes`;
const SCOPE_LIMIT = 8;
const LIMIT = 8;
const MAX_QUERY_LENGTH = 200;
let memory: string[] = [];
// A saved list belongs to one exact household Owner. Any other profile keeps its searches in memory for the session,
// so neither can read, extend or clear the other's after a switch.
let activeScope: string | undefined;
let activeStorageKey: string | undefined;

export const RECENT_SEARCHES_CHANGED = 'den:recent-searches-changed';

const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
const browserStorage = (): Storage | undefined => {
  if (!activeStorageKey) return undefined;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

function retainScope(storage: Storage, storageKey: string): void {
  const tag = storageKey.slice(STORAGE_PREFIX.length + 1);
  const storedScopes = storage.getItem(SCOPES_KEY);
  const previous = storedScopes?.match(/[0-9a-f]{16}/g) ?? [];
  const scopes = [tag, ...previous.filter((value) => value !== tag)];
  for (const retired of scopes.slice(SCOPE_LIMIT))
    storage.removeItem(`${STORAGE_PREFIX}:${retired}`);
  const nextScopes = scopes.slice(0, SCOPE_LIMIT).join();
  if (storedScopes !== nextScopes) storage.setItem(SCOPES_KEY, nextScopes);
}

/**
 * Choose whose searches the default storage serves: an opaque, exact household-and-Owner namespace, or a fresh
 * in-memory list for one profile session. Changing household, profile or storage authority empties the in-memory
 * list, so nothing typed under one authority is offered to the next. The retired origin-global key is deleted but
 * never adopted: its plaintext could belong to a different household. An opaque registry bounds namespaces while
 * keeping recently used households available when this browser returns to them.
 */
export function scopeRecentSearches(
  persist: boolean,
  householdKey: string | null,
  profile: string,
): void {
  const scope = `${persist}:${householdKey ?? ''}:${profile}`;
  if (scope === activeScope) return;
  const storageKey =
    persist && householdKey
      ? `${STORAGE_PREFIX}:${householdTag(householdKey, `${STORAGE_PREFIX}:${profile}`)}`
      : undefined;
  activeScope = scope;
  activeStorageKey = storageKey;
  memory = [];
  try {
    const storage = globalThis.localStorage;
    storage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // The active scope still remains memory-only when storage is blocked.
  }
  changed(readRecentSearches());
}

/** This browser's recent explicit title searches, newest first. */
export function readRecentSearches(storage: Storage | undefined = browserStorage()): string[] {
  const key = activeStorageKey;
  if (!storage || !key) return memory;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]');
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
  const key = activeStorageKey;
  try {
    if (key && storage) retainScope(storage, key);
    if (key && searches.length) storage?.setItem(key, JSON.stringify(searches));
    else if (key) storage?.removeItem(key);
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
  return event.key === activeStorageKey || event.key === null;
}
