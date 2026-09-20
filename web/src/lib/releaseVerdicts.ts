// What den-remux says of the releases a title offers, and what the player owes a viewer when it opened a
// different one from the one they picked.

import type { Release, Session } from './remux';

/**
 * The line to show when the session opened another release than the one asked for, or null when it opened that one
 * (or none was asked for). The reason is den-remux's own words, and only when it gave one.
 *
 * `requestedName` is how to call the release asked for: its label where the list has it, else its filename.
 */
export function swapNotice(
  asked: string | undefined,
  session: Session,
  requestedName: (filename: string) => string = (filename) => filename,
): string | null {
  const said = session.release.requested;
  const filename = said?.filename ?? asked;
  if (!filename || filename === session.release.filename) return null;
  const what = requestedName(filename);
  const why = said?.why?.trim();
  const cannot = why
    ? `Couldn’t play ${what} here (${why})`
    : `Couldn’t play ${what} in this browser`;
  return `${cannot} — playing ${session.release.label} instead.`;
}

/** The releases this browser can't play, by filename, each with den-remux's reason (empty when it gave none). */
export function unplayable(releases: readonly Release[] | null | undefined): Map<string, string> {
  const refused = new Map<string, string>();
  for (const release of releases ?? [])
    if (release.plays === 'no') refused.set(release.filename, release.why ?? '');
  return refused;
}

/** The option text for a release in the player's picker: a quiet marker where it won't play as it is. */
export function optionLabel(release: Release): string {
  if (release.plays === 'no') return `${release.label} — can’t play here`;
  if (release.plays === 'convert') return `${release.label} — converted`;
  return release.label;
}
