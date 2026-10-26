// The household's TVs that take plays (den-spec inbox-v1 §5), as every Play on TV control lists them.

import type { LibraryDeviceView } from './libraryServiceProtocol';

/** A TV in the household that takes plays from any device holding the library. */
export interface HouseholdTv {
  id: string;
  name: string;
  /** Its household play key, base64url. */
  play: string;
  /** Whether this TV advertises the household transport protocol. */
  controls?: boolean;
}

/** Pick a transport receiver from probes ordered with the playback writer first. */
export function listeningTransportTv<T>(
  probed: readonly { tv: T; listening: boolean | null }[],
): T | undefined {
  const intended = probed[0];
  if (intended?.listening) return intended.tv;
  const awake = probed.filter(({ listening }) => listening);
  if (awake.length === 1) return awake[0]?.tv;
  // A backend being rolled out cannot answer the probe yet; retain the exact-device behavior until it can.
  if (intended && probed.every(({ listening }) => listening === null)) return intended.tv;
  return undefined;
}

/**
 * The household's TVs that take plays, the one a play last started on first (`<d>.played`), then the most recently
 * seen. A TV too old to publish a play key isn't one: it cannot take household playback commands.
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
    .map(({ id, name, playKey, controlVersion }) => ({
      id,
      name,
      play: playKey!,
      controls: (controlVersion ?? 0) >= 1,
    }));
}

/** "Play on TV" with one TV; with several, each by its name. */
export function playOnLabel(tv: HouseholdTv, tvs: readonly HouseholdTv[], verb = 'Play'): string {
  return tvs.length > 1 ? `${verb} on ${tv.name}` : `${verb} on TV`;
}
