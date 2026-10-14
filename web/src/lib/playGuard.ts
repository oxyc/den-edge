// The household's parental ceiling, enforced where every "Play" actually starts — `Library.svelte`'s
// `play`/`playHere`, which the billboard's own Play button and the poster's ⋯ menu both call into — rather than
// left to each caller to remember. Detail.svelte's own `restricted` is a UI omission (it simply doesn't draw its
// Play button for a title it already knows is blocked); this is the one place that actually refuses a start,
// using the same normalized detail lookup and `isBlocked` rule.

import type { MediaType } from './library';
import type { ContentServiceClientPort } from './contentServiceClient';
import { isBlocked } from './parental';

/** The same line `Detail.svelte` shows in Play's place for a title its page already knows is blocked. */
export const BLOCKED_MESSAGE = 'Blocked by parental controls';

export interface PlayGuardOptions {
  content: ContentServiceClientPort;
  region?: string;
  ceiling?: 'pg13' | 'r';
  /** The active profile runs under a numeric content policy (`ProfileSession.restricted`). */
  restricted?: boolean;
}

/**
 * Whether the active profile's policy establishes `ref`: the one shared age check (`title.eligibility`) that every
 * boundary — Play, Sources, remux, autoplay, downloads, cast, assistant — asks. A check that cannot be answered is a
 * refusal. A profile with no policy skips the round trip.
 */
export async function titleAllowed(
  ref: { type: MediaType; id: number },
  { content, restricted }: Pick<PlayGuardOptions, 'content' | 'restricted'>,
): Promise<boolean> {
  if (!restricted) return true;
  const asked = { type: ref.type, id: ref.id };
  return content.query({ kind: 'title.eligibility', titles: [asked] }).then(
    (answer) => answer.allowed.length === 1,
    () => false,
  );
}

/**
 * Resolves to the refusal message when `ref` may not play, or `null` when it may.
 *
 * The numeric profile policy is checked first; then the household's legacy ceiling. No ceiling blocks nothing, so
 * nothing is looked up for one — the common case, and a guest's always. A lookup that fails WITH a ceiling set fails
 * closed: a title this couldn't check for is refused rather than screened through, since the one wrong answer costs
 * a retry and the other costs exactly what the ceiling is for.
 */
export async function playGuard(
  ref: { type: MediaType; id: number },
  { content, region = 'US', ceiling, restricted }: PlayGuardOptions,
): Promise<string | null> {
  if (!(await titleAllowed(ref, { content, restricted }))) return BLOCKED_MESSAGE;
  if (!ceiling) return null;
  const answer = await content
    .query({ kind: 'title.detail', title: ref, region })
    .catch(() => null);
  const detail = answer?.detail.state === 'ready' ? answer.detail.value : null;
  if (!detail) return BLOCKED_MESSAGE;
  return isBlocked(detail.certifications, region, ceiling) ? BLOCKED_MESSAGE : null;
}
