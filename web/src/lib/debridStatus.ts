// The household's debrid service (TorBox, behind Hearth) as Hearth reports it. Both wire shapes Den reads are in the
// two adapters below and nowhere else, so a change to Hearth's contract is a change to one function each.

import { relayFetch } from './relayFetch';
import type { Addon } from './scout';

export type DebridState = 'ok' | 'slow' | 'down';
export type DebridPlayCode = 'debrid_down' | 'debrid_slow';

/**
 * Hearth's `/health` → the debrid state: `{…, "debrid": {"provider", "state": "ok"|"slow"|"down", "since", "reason"}}`.
 * Hearth leaves `debrid` out until it has asked TorBox anything, so an answer without it, or with a state Den doesn't
 * know, is null: nothing is said about it.
 */
export function debridStateOf(health: unknown): DebridState | null {
  const debrid = (health as { debrid?: { state?: unknown } } | null)?.debrid;
  const state = debrid?.state;
  return state === 'ok' || state === 'slow' || state === 'down' ? state : null;
}

/**
 * A refused play → its debrid code. A 503 that could not ask the debrid names TorBox's health in `X-Den-Degraded`
 * (`debrid_down` or `debrid_slow`); a play refused because TorBox is known down is `{"error": "debrid_down",
 * "service": "torbox"}`. Anything else is undefined, including a failed play's own code that only names the state
 * (`404 no_release` with `debrid_slow`): that answer stays what it is.
 */
export function debridPlayCodeOf(response: Response, body: unknown): DebridPlayCode | undefined {
  if (response.status !== 503) return undefined;
  const degraded = response.headers.get('x-den-degraded');
  if (degraded === 'debrid_down' || degraded === 'debrid_slow') return degraded;
  const answer = body as { error?: unknown; service?: unknown } | null;
  return answer?.error === 'debrid_down' && String(answer.service).toLowerCase() === 'torbox'
    ? 'debrid_down'
    : undefined;
}

/**
 * One read of the debrid state for the playback addon just discovered; null when it can't be said. Only Hearth's
 * combined addon (`/den/<config>`) is asked, at `/den/health`, its aggregate report. A legacy Scout install, or a shared
 * addon's `~<gid>` base, is never asked.
 */
export async function readDebridState(
  addon: Addon,
  fetchImpl: typeof fetch = relayFetch,
): Promise<DebridState | null> {
  if (!/^\/den\/(?!~)/.test(addon.base)) return null;
  try {
    const res = await fetchImpl('/den/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
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
