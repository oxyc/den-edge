const HINT_KEY = 'den.household.wire5.v1';
const MAX_HINTS = 16;

/**
 * A short, one-way name for a household in this browser's storage: the key itself is never written there. FNV-1a
 * over 64 bits, synchronous so the library's first open is not held back for it; a household key is 32 random bytes,
 * so the 64 bits kept say nothing usable about it. Prefixed so it matches no other use of the same key.
 */
function householdTag(libraryKey: string): string {
  // FNV-1a's 64-bit offset basis, kept as two uint32 words so Chromium 47 does not need BigInt. Multiplication by
  // the prime 0x100000001b3 is `hash * 0x1b3 + hash * 2^40`; every intermediate below stays below 2^53.
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (const byte of new TextEncoder().encode(`den.household.wire5:${libraryKey}`)) {
    low = (low ^ byte) >>> 0;
    const lowProduct = low * 0x1b3;
    high = (high * 0x1b3 + Math.floor(lowProduct / 0x1_0000_0000) + low * 0x100) >>> 0;
    low = lowProduct >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

function readTags(storage: Storage): string[] {
  const value: unknown = JSON.parse(storage.getItem(HINT_KEY) ?? '[]');
  return Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : [];
}

/**
 * Whether this browser has seen `libraryKey` require wire 5. Profile mode is permanent, so a household once seen
 * needing wire 5 always will. Blocked or damaged storage answers false, which opens on wire 4 and
 * bootstraps as before.
 */
export function knownProfileHousehold(
  libraryKey: string,
  storage: Storage = localStorage,
): boolean {
  try {
    return readTags(storage).includes(householdTag(libraryKey));
  } catch {
    return false;
  }
}

/** Remember that `libraryKey` opened on wire 5 after den-edge refused it on wire 4. */
export function rememberProfileHousehold(
  libraryKey: string,
  storage: Storage = localStorage,
): void {
  try {
    const tag = householdTag(libraryKey);
    const tags = readTags(storage).filter((kept) => kept !== tag);
    storage.setItem(HINT_KEY, JSON.stringify([tag, ...tags].slice(0, MAX_HINTS)));
  } catch {
    // Without the hint the next load opens on wire 4 and bootstraps again.
  }
}
