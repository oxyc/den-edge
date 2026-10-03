// The household's parental ceiling, enforced where every "Play" actually starts — `Library.svelte`'s
// `play`/`playHere`, which the billboard's own Play button and the poster's ⋯ menu both call into — rather than
// left to each caller to remember. Detail.svelte's own `restricted` is a UI omission (it simply doesn't draw its
// Play button for a title it already knows is blocked); this is the one place that actually refuses a start,
// using the same certification lookup (`fetchDetail`, den-edge's cached `/tmdb` proxy) and `isBlocked` rule.

import { fetchDetail } from './detail';
import type { MediaType } from './library';
import { isBlocked } from './parental';
import { TMDB_PROXY_KEY } from './tmdbCache';

/** The same line `Detail.svelte` shows in Play's place for a title its page already knows is blocked. */
export const BLOCKED_MESSAGE = 'Blocked by parental controls';

export interface PlayGuardOptions {
  /** The household's key where it has one; den-edge's own shared proxy key otherwise (as `warmDetail` uses). */
  tmdbKey?: string;
  region?: string;
  ceiling?: 'pg13' | 'r';
  fetchImpl?: typeof fetch;
}

/**
 * Resolves to the refusal message when `ref` may not play, or `null` when it may.
 *
 * No ceiling blocks nothing, so nothing is looked up for one — the common case, and a guest's always. A lookup
 * that fails WITH a ceiling set fails closed: a title this couldn't check for is refused rather than screened
 * through, since the one wrong answer costs a retry and the other costs exactly what the ceiling is for.
 */
export async function playGuard(
  ref: { type: MediaType; id: number },
  { tmdbKey, region = 'US', ceiling, fetchImpl }: PlayGuardOptions = {},
): Promise<string | null> {
  if (!ceiling) return null;
  const detail = await fetchDetail(ref, tmdbKey || TMDB_PROXY_KEY, fetchImpl, region);
  if (!detail) return BLOCKED_MESSAGE;
  return isBlocked(detail.certifications, region, ceiling) ? BLOCKED_MESSAGE : null;
}
