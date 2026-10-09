// The library a browser keeps for itself when it has no TV (`LibraryLog.openLocal`): its key, made once and kept in
// this browser like a link's, so the watchlist, what was watched and Settings are all still there next visit. Linking a
// TV moves the library into the TV's and drops this one.

import { forgetLibrary } from './localVault';
import { forgetHeroLeadPointers } from './heroLeadPointer';

const STORAGE_KEY = 'den.localLibrary';
const PENDING_MERGES_KEY = 'den.localLibraryMerges';

/** Read the current local owner without creating one. */
export function keptLocalLibraryKey(
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** This browser's own library key, made the first time it's asked for; null where nothing can be kept here. */
export function localLibraryKey(
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  try {
    const kept = keptLocalLibraryKey(storage);
    if (kept) return kept;
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    storage?.setItem(STORAGE_KEY, key);
    // Read back: a key that didn't stick would make a new, empty library every visit.
    return storage?.getItem(STORAGE_KEY) === key ? key : null;
  } catch {
    return null;
  }
}

/**
 * Drop exactly the browser-local library that was merged. A concurrent tab may have published a newer winner while
 * the merge was in flight; that winner must never be removed or forgotten here.
 */
export async function dropLocalLibrary(
  expectedKey: string,
  storage: Storage | undefined = globalThis.localStorage,
): Promise<boolean> {
  try {
    if (storage?.getItem(STORAGE_KEY) !== expectedKey) return false;
    storage?.removeItem(STORAGE_KEY);
  } catch {
    return false;
  }
  forgetHeroLeadPointers(expectedKey, storage);
  // The semantic merge already forgot this source. This is a best-effort cleanup for an absent/empty source.
  await forgetLibrary(expectedKey).catch(() => {});
  return true;
}

function pendingMerges(storage: Storage | undefined): string[] {
  try {
    const value = JSON.parse(storage?.getItem(PENDING_MERGES_KEY) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.filter(
          (key, index): key is string => typeof key === 'string' && value.indexOf(key) === index,
        )
      : [];
  } catch {
    return [];
  }
}

function writePendingMerges(keys: readonly string[], storage: Storage | undefined): boolean {
  try {
    if (keys.length) storage?.setItem(PENDING_MERGES_KEY, JSON.stringify(keys));
    else storage?.removeItem(PENDING_MERGES_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Persist a losing first-tab key before yielding, so a crash cannot strand its rows forever. */
export function rememberLocalLibraryMerge(
  sourceKey: string,
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  const keys = pendingMerges(storage);
  return keys.includes(sourceKey) || writePendingMerges([...keys, sourceKey], storage);
}

/** Losing keys still owed to the current winner. The winner itself is never offered as its own source. */
export function pendingLocalLibraryMerges(
  winnerKey: string,
  storage: Storage | undefined = globalThis.localStorage,
): string[] {
  return pendingMerges(storage).filter((key) => key !== winnerKey);
}

/** Clear one source only after the authority says it was merged or was already absent. */
export function settleLocalLibraryMerge(
  sourceKey: string,
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  return writePendingMerges(
    pendingMerges(storage).filter((key) => key !== sourceKey),
    storage,
  );
}

/**
 * Follow this browser's own library key when another tab replaces it (`storage`). Two tabs opened together on a first
 * visit each found no key and made one; the one written last is kept, and the other tab wrote to a library no later
 * visit opens, for as long as it stayed open. That tab's rows are now written into the kept library and its own is
 * dropped, and `rekey` is told the key to go on with. `rekey` is told even when the rows couldn't be moved: staying on
 * the lost key would lose everything after too. The function returned stops following.
 */
/**
 * Observe only the winning local key. The LibraryModel owner performs the guarded semantic merge before replacing
 * its session; this key watcher deliberately has no storage or row authority of its own.
 */
export function followLocalLibraryKey(
  own: string,
  changed: (next: string, previous: string) => void,
  target: EventTarget = window,
): () => void {
  let current = own;
  const listener = (event: Event) => {
    const { key, newValue } = event as StorageEvent;
    if (key !== STORAGE_KEY || !newValue || newValue === current) return;
    const previous = current;
    current = newValue;
    changed(newValue, previous);
  };
  target.addEventListener('storage', listener);
  return () => target.removeEventListener('storage', listener);
}
