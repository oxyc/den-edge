// The household's debrid service (TorBox, behind Hearth) as Hearth reports it. Both wire shapes Den reads are in the
// two adapters below and nowhere else, so a change to Hearth's contract is a change to one function each.

import { relayFetch } from './relayFetch';
import type { Addon } from './scout';

export type DebridState = 'ok' | 'slow' | 'down';
export type DebridPlayCode = 'debrid_down' | 'debrid_slow' | 'release_uncached';

/**
 * Hearth's `/health` → the debrid state: `{…, "debrid": {"provider", "state": "ok"|"slow"|"down", "since", "reason"}}`.
 * An answer without `debrid`, or with a state Den doesn't know, is null: nothing is said about it.
 */
export function debridStateOf(health: unknown): DebridState | null {
  const debrid = (health as { debrid?: { state?: unknown } } | null)?.debrid;
  const state = debrid?.state;
  return state === 'ok' || state === 'slow' || state === 'down' ? state : null;
}

/** A refused play's body → its debrid code, carried as `cause` (or as the `error` itself); else undefined. */
export function debridPlayCodeOf(body: unknown): DebridPlayCode | undefined {
  const answer = body as { cause?: unknown; error?: unknown } | null;
  for (const code of [answer?.cause, answer?.error])
    if (code === 'debrid_down' || code === 'debrid_slow' || code === 'release_uncached')
      return code;
  return undefined;
}

/**
 * Where the playback addon's Hearth answers its health: the mount of the addon's base (`/den/<config>` → `/den/health`,
 * which Hearth answers with its aggregate report). A shared addon's `~<gid>` base has no health of its own here.
 */
function healthOf(addon: Addon): string | null {
  const mount = /^\/(den|scout)\/(?!~)/.exec(addon.base)?.[1];
  return mount ? `/${mount}/health` : null;
}

/** One read of the debrid state for the playback addon just discovered; null when it can't be said. */
export async function readDebridState(
  addon: Addon,
  fetchImpl: typeof fetch = relayFetch,
): Promise<DebridState | null> {
  const path = healthOf(addon);
  if (!path) return null;
  try {
    const res = await fetchImpl(path, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    return res.ok ? debridStateOf(await res.json()) : null;
  } catch {
    return null;
  }
}

/** What the page toast says of a state, or null for one that needs nothing said. */
export function debridNotice(state: DebridState | null): string | null {
  if (state === 'down') return 'TorBox isn’t responding right now — playback may fail.';
  if (state === 'slow') return 'TorBox is slow right now — streams may take longer to start.';
  return null;
}
