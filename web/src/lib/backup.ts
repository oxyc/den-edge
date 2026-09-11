// The TV's library backup on den-edge (`/sync/<id>`), opened in the browser: den-edge only ever holds the
// ciphertext. Read-only — the record log's client takes over writes.

import { libraryId, libraryKey, open, type Sealed } from './crypto';
import { parseSnapshot, swiftDate, type Library } from './library';

export type LibraryResult =
  | { state: 'ok'; library: Library; backedUpAt: number }
  | { state: 'none' }
  | { state: 'error'; reason: 'unreachable' | 'unreadable' };

export async function loadLibrary(inboxKey: string, fetchImpl: typeof fetch = fetch): Promise<LibraryResult> {
  const key = await libraryKey(inboxKey);
  let res: Response;
  try {
    res = await fetchImpl(`/sync/${await libraryId(key)}`);
  } catch {
    return { state: 'error', reason: 'unreachable' };
  }
  if (res.status === 404) return { state: 'none' };
  if (!res.ok) return { state: 'error', reason: 'unreachable' };
  try {
    const sealed = (await res.json()) as Sealed;
    const snapshot: unknown = JSON.parse(new TextDecoder().decode(await open(key, sealed)));
    return {
      state: 'ok',
      library: parseSnapshot(snapshot),
      backedUpAt: swiftDate((snapshot as { createdAt?: unknown }).createdAt),
    };
  } catch {
    // Sealed under another key — a backup from an older link — or not a snapshot at all.
    return { state: 'error', reason: 'unreadable' };
  }
}
