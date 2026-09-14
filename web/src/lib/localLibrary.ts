// The library a browser keeps for itself when it has no TV (`LibraryLog.openLocal`): its key, made once and kept in
// this browser like a link's, so the watchlist, what was watched and Settings are all still there next visit. Linking a
// TV moves the library into the TV's and drops this one.

import { forgetLibrary } from './localVault';

const STORAGE_KEY = 'den.localLibrary';

/** This browser's own library key, made the first time it's asked for; null where nothing can be kept here. */
export function localLibraryKey(
  storage: Storage | undefined = globalThis.localStorage,
): string | null {
  try {
    const kept = storage?.getItem(STORAGE_KEY);
    if (kept) return kept;
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    storage?.setItem(STORAGE_KEY, key);
    // Read back: a key that didn't stick would make a new, empty library every visit.
    return storage?.getItem(STORAGE_KEY) === key ? key : null;
  } catch {
    return null;
  }
}

/** Drop this browser's own library: its key, and what was kept under it. */
export async function dropLocalLibrary(
  storage: Storage | undefined = globalThis.localStorage,
): Promise<void> {
  let key: string | null = null;
  try {
    key = storage?.getItem(STORAGE_KEY) ?? null;
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more to drop than was kept.
  }
  if (key) await forgetLibrary(key);
}
