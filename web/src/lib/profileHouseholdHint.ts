const HINT_KEY = 'den.household.wire5.v1';
const MAX_HINTS = 16;

/**
 * A short, one-way name for a household in this browser's storage: the key itself is never written there. Prefixed so
 * it cannot be matched against a hash of the same key kept for any other purpose.
 */
async function householdTag(libraryKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`den.household.wire5:${libraryKey}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
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
export async function knownProfileHousehold(
  libraryKey: string,
  storage: Storage = localStorage,
): Promise<boolean> {
  try {
    return readTags(storage).includes(await householdTag(libraryKey));
  } catch {
    return false;
  }
}

/** Remember that `libraryKey` opened on wire 5 after den-edge refused it on wire 4. */
export async function rememberProfileHousehold(
  libraryKey: string,
  storage: Storage = localStorage,
): Promise<void> {
  try {
    const tag = await householdTag(libraryKey);
    const tags = readTags(storage).filter((kept) => kept !== tag);
    storage.setItem(HINT_KEY, JSON.stringify([tag, ...tags].slice(0, MAX_HINTS)));
  } catch {
    // Without the hint the next load opens on wire 4 and bootstraps again.
  }
}
