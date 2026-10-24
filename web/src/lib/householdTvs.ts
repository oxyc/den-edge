// The household's TVs that take plays (den-spec inbox-v1 §5), as every Play on TV control lists them.

import type { LibraryDeviceView } from './libraryServiceProtocol';

/** A TV in the household that takes plays from any device holding the library. */
export interface HouseholdTv {
  id: string;
  name: string;
  /** Its household play key, base64url. */
  play: string;
}

/**
 * The household's TVs that take plays, the one a play last started on first (`<d>.played`), then the most recently
 * seen. A TV too old to publish a play key isn't one: it can't be reached without a pairing.
 */
export function householdTvs(
  devices: readonly Readonly<LibraryDeviceView>[] | undefined,
): HouseholdTv[] {
  return (devices ?? [])
    .filter((d) => d.kind === 'tv' && d.playKey !== undefined)
    .sort(
      (a, b) =>
        (b.playedAt ?? 0) - (a.playedAt ?? 0) ||
        (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .map(({ id, name, playKey }) => ({ id, name, play: playKey! }));
}

/** "Play on TV" with one TV; with several, each by its name. */
export function playOnLabel(tv: HouseholdTv, tvs: readonly HouseholdTv[], verb = 'Play'): string {
  return tvs.length > 1 ? `${verb} on ${tv.name}` : `${verb} on TV`;
}
