const HINT_KEY = 'den.household.wire5.v1';
const MAX_HINTS = 16;

/**
 * A short, one-way name for a household in this browser's storage: the key itself is never written there. FNV-1a
 * over 64 bits, synchronous so the library's first open is not held back for it; a household key is 32 random bytes,
 * so the 64 bits kept say nothing usable about it. Prefixed so it matches no other use of the same key.
 */
function householdTag(libraryKey: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`den.household.wire5:${libraryKey}`)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function readTags(storage: Storage): string[] {
  const value: unknown = JSON.parse(storage.getItem(HINT_KEY) ?? '[]');
  return Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : [];
}

/**
 * Whether this browser has seen `libraryKey` bootstrapped from wire 4 to wire 5. The Owner split is one-way, so a
 * household once seen needing wire 5 always will. Blocked or damaged storage answers false, which opens on wire 4 and
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
