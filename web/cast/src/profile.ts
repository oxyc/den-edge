const PROFILE_KEY = 'den.cast.profile';

/**
 * This page's storage, or undefined where the browser refuses it. A third-party frame with storage blocked (the cast
 * page is one, inside the player) throws on reading `localStorage` at all.
 */
function profileStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch (error) {
    console.warn('No local storage: the receiver profile is not remembered.', error);
    return undefined;
  }
}

/** The receiver profile chosen last time, as the picker now names it; null when none was, or it can't be read. */
export function keptProfile(storage = profileStorage()): string | null {
  try {
    const stored = storage?.getItem(PROFILE_KEY) ?? null;
    return stored === 'google-tv' ? 'google-tv-4k' : stored;
  } catch {
    return null;
  }
}

/** Remember the receiver profile chosen, where the browser lets this page remember anything. */
export function keepProfile(profile: string, storage = profileStorage()): void {
  try {
    storage?.setItem(PROFILE_KEY, profile);
  } catch {
    // Not remembered: chosen again next time.
  }
}
