// A guest's own synced library (oxyc/den-edge#390). Anyone invited gets one: a browser that holds a live guest grant
// and no synced library starts one, and what it saved on its own moves in, as when a TV is linked. The grant is only
// the permission to start it (den-edge `POST /grant/library`); from then on the library is the guest's, whatever
// becomes of the grant, and every later device joins it with the "Use Den on your phone" link (`phoneLink.ts`).

import { reserveLibrary } from './grants';
import { guestGrants, type GuestGrant } from './grants.svelte';
import { links } from './links.svelte';
import { deriveKeys } from './wire';

/** The library key being started for a grant, kept until it is: a retry after a lost answer must send the same key. */
const PENDING_KEY = 'den.guestLibrary.pending';
/** Grants den-edge turned down for a library (they already started one, on another device): not asked again. */
const REFUSED_KEY = 'den.guestLibrary.refused';

export type StartOutcome =
  /** The library is started and this browser holds it. */
  | 'started'
  /** Nothing to do: this browser already holds a synced library, or the grant has had its one. */
  | 'held'
  /** Not now (offline, or the move failed): the same key is tried again. */
  | 'failed';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function refusedGrants(): string[] {
  try {
    const kept = JSON.parse(storage()?.getItem(REFUSED_KEY) ?? '[]') as unknown;
    return Array.isArray(kept) ? kept.filter((gid): gid is string => typeof gid === 'string') : [];
  } catch {
    return [];
  }
}

function refuse(gid: string): void {
  try {
    storage()?.setItem(REFUSED_KEY, JSON.stringify([...new Set([...refusedGrants(), gid])]));
    storage()?.removeItem(PENDING_KEY);
  } catch {
    // Asked once more next visit, and refused again.
  }
}

function pendingKey(gid: string): string {
  try {
    const kept = JSON.parse(storage()?.getItem(PENDING_KEY) ?? 'null') as {
      gid?: unknown;
      libraryKey?: unknown;
    } | null;
    if (kept?.gid === gid && typeof kept.libraryKey === 'string') return kept.libraryKey;
  } catch {
    // Unreadable: a fresh key.
  }
  const libraryKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  try {
    storage()?.setItem(PENDING_KEY, JSON.stringify({ gid, libraryKey }));
  } catch {
    // Without storage a reload makes a new key, and den-edge turns it down: the grant has its one.
  }
  return libraryKey;
}

/** The grant a browser with no synced library would start one with: live, and not already turned down. */
export function startingGrant(): GuestGrant | undefined {
  if (links.current) return undefined;
  const refused = refusedGrants();
  return guestGrants.list.find((g) => !g.ended && g.secret && !refused.includes(g.gid));
}

/**
 * Start the synced library `grant` allows, move this browser's own library into it, and hold it from then on.
 * `move` is the library authority's merge of the local library into the one a key opens (`RoutedLibrary`); it runs
 * only after den-edge has reserved the library, because its first write is what starts it.
 */
export async function startGuestLibrary(
  grant: GuestGrant,
  move: (libraryKey: string) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch,
): Promise<StartOutcome> {
  if (links.current || refusedGrants().includes(grant.gid)) return 'held';
  const libraryKey = pendingKey(grant.gid);
  const keys = await deriveKeys(Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0)));
  const reserved = await reserveLibrary(grant.gid, grant.secret, keys, fetchImpl);
  if (!reserved.ok) {
    // `new_libraries_closed`: the grant started its library on another device. That one is the guest's library, and
    // this device joins it with the "Use Den on your phone" link.
    if (reserved.status === 403) {
      refuse(grant.gid);
      return 'held';
    }
    return 'failed';
  }
  if (!(await move(libraryKey))) return 'failed';
  links.addRecovered(libraryKey, { name: 'your library', guest: true });
  try {
    storage()?.removeItem(PENDING_KEY);
  } catch {
    // Harmless: the held library makes the key unused.
  }
  return 'started';
}
