// The name this browser goes by when it pairs. Guessed from the browser ("iPhone · Safari"), which two phones of
// the same make share exactly — so the guess is only a starting point, and the name is the user's to change. It is
// what the device on the other side asks to allow, and what its list of linked devices keeps.

import { cleanLabel, deviceLabel } from './edge';

const STORAGE_KEY = 'den.deviceName';

/** Storage can throw outright (a private window, blocked site data), so every access is guarded. */
function read(): string {
  try {
    return cleanLabel(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

class ThisDevice {
  /** What the user typed, or empty while the guess stands. */
  chosen = $state(read());

  /** What to pair as: the chosen name, else what the browser looks like. */
  get name(): string {
    return this.chosen || deviceLabel();
  }

  /** The guess, whether or not a name has been chosen: the placeholder, and what clearing the field falls back to. */
  get guess(): string {
    return deviceLabel();
  }

  rename(raw: string): void {
    this.chosen = cleanLabel(raw);
    try {
      if (this.chosen) globalThis.localStorage?.setItem(STORAGE_KEY, this.chosen);
      else globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      // Nothing persists in this browser; the name still holds for this visit.
    }
  }
}

export const thisDevice = new ThisDevice();
