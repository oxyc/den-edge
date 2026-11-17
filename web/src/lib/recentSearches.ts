import { householdTag } from './profileHouseholdHint';

const LEGACY_STORAGE_KEY = 'den.recentSearches';
const STORAGE_PREFIX = 'den.searches.v2';
const SCOPES_KEY = `${STORAGE_PREFIX}.scopes`;
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
  const storedScopes = storage.getItem(SCOPES_KEY) ?? '';
  const scopes = `${tag},${storedScopes.replace(`${tag},`, '')}`;
  for (let offset = LIMIT * 17; offset < scopes.length; offset += 17)
    storage.removeItem(`${STORAGE_PREFIX}:${scopes.slice(offset, offset + 16)}`);
  const nextScopes = scopes.slice(0, LIMIT * 17);
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
  const storageKey =
    persist && householdKey
      ? `${STORAGE_PREFIX}:${householdTag(`${householdKey}\0${profile}`)}`
      : undefined;
  const scope = storageKey ?? `${householdKey}:${profile}`;
  if (scope === activeScope) return;
  activeScope = scope;
  activeStorageKey = storageKey;
  memory = [];
  changed(readRecentSearches());
}

/** This browser's recent explicit title searches, newest first. */
export function readRecentSearches(): string[] {
  const storage = browserStorage();
  if (!storage) return memory;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(activeStorageKey!) ?? '[]');
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

function write(searches: string[]): string[] {
  memory = searches;
  const storage = browserStorage();
  try {
    if (storage) {
      const key = activeStorageKey!;
      storage.removeItem(LEGACY_STORAGE_KEY);
      retainScope(storage, key);
      if (searches.length) storage.setItem(key, JSON.stringify(searches));
      else storage.removeItem(key);
    }
  } catch {
    // The list still works for this visit when storage is blocked.
  }
  changed(searches);
  return searches;
}

/** Keep an explicit search, deduplicated without changing the user's casing. */
export function rememberSearch(query: string): string[] {
  const value = clean(query);
  if (value.length < 2 || value.length > MAX_QUERY_LENGTH) return readRecentSearches();
  const key = value.toLocaleLowerCase();
  return write(
    [value, ...readRecentSearches().filter((recent) => recent.toLocaleLowerCase() !== key)].slice(
      0,
      LIMIT,
    ),
  );
}

export function forgetSearch(query: string): string[] {
  const key = clean(query).toLocaleLowerCase();
  return write(readRecentSearches().filter((recent) => recent.toLocaleLowerCase() !== key));
}

export function clearRecentSearches(): string[] {
  return write([]);
}

export function isRecentSearchStorageEvent(event: StorageEvent): boolean {
  return event.key === activeStorageKey || event.key === null;
}
