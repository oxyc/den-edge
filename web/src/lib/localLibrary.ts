// The library a browser keeps for itself when it has no TV (`LibraryLog.openLocal`): its key, made once and kept in
// this browser like a link's, so the watchlist, what was watched and Settings are all still there next visit. Linking a
// TV moves the library into the TV's and drops this one.

import { forgetLibrary, libraryVault, type Vault } from './localVault';
import { LibraryLog } from './log';

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

/**
 * Follow this browser's own library key when another tab replaces it (`storage`). Two tabs opened together on a first
 * visit each found no key and made one; the one written last is kept, and the other tab wrote to a library no later
 * visit opens, for as long as it stayed open. That tab's rows are now written into the kept library and its own is
 * dropped, and `rekey` is told the key to go on with. `rekey` is told even when the rows couldn't be moved: staying on
 * the lost key would lose everything after too. The function returned stops following.
 */
export function followLocalLibrary(
  own: string,
  rekey: (key: string) => void,
  target: EventTarget = window,
  vault: Vault | null = libraryVault,
): () => void {
  let current = own;
  let moving = Promise.resolve();
  const listener = (event: Event) => {
    const { key, newValue } = event as StorageEvent;
    if (key !== STORAGE_KEY || !newValue || newValue === current) return;
    const lost = current;
    current = newValue;
    moving = moving
      .then(() => mergeLocalLibrary(lost, newValue, vault))
      .catch(() => false)
      .then(() => {
        if (current === newValue) rekey(newValue);
      });
  };
  target.addEventListener('storage', listener);
  return () => target.removeEventListener('storage', listener);
}

/** Every row of the library `lost` opens written into `kept`'s, and `lost` dropped. False when either can't be opened. */
async function mergeLocalLibrary(
  lost: string,
  kept: string,
  vault: Vault | null,
): Promise<boolean> {
  const [from, into] = await Promise.all([
    LibraryLog.openLocal(lost, vault),
    LibraryLog.openLocal(kept, vault),
  ]);
  if (!from || !into || !(await into.writeRows(from.rows()))) return false;
  return from.forget();
}
