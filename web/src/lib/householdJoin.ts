// A browser's own household (den#295) joining another, typically a TV's: the household joined keeps its identity,
// settings and Owner PIN, and the browser's household brings its activity. Its Owner's documents merge into the
// joined household's Owner library; each Kid's into a Kid of the same name and age there, or into one made for it
// through the Kid journal under a fixed operation id. Once den-edge is proved to hold all of it, the browser's
// household and its profile libraries are retired, each at the head that was carried, so a write that lands meanwhile
// refuses the retirement rather than being lost. Every step is idempotent and the progress is kept, so a run cut off
// anywhere is finished by the next, with nothing merged twice and no second Kid.

import type { ProfileDirectoryDocument } from './profileDirectory';
import type { DocumentRow } from './wire';

export interface JoinProfile {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly maximumAge: number | null;
}

export interface JoinHousehold {
  readonly owner: JoinProfile;
  readonly kids: readonly JoinProfile[];
}

/** Kept on this device for the household joined, per source household. */
export interface JoinState {
  readonly version: 1;
  /** The Owner PIN of the household joined was entered for this join. */
  readonly authorized?: true;
  /** Source Kid id to the Kid it merges into. */
  readonly kids: Readonly<Record<string, string>>;
}

/** A profile library of the browser's household as read: its documents and den-edge's head; `head` null once retired. */
export interface JoinRead {
  readonly documents: DocumentRow[];
  readonly head: number | null;
}

export interface JoinIO {
  state(): Promise<JoinState | null>;
  keep(state: JoinState): Promise<void>;
  /** The browser's household, read fresh; `gone` once it is retired. */
  source(): Promise<JoinHousehold | 'gone'>;
  /** The household joined, read fresh: its profiles (null when it has none) and whether it has an Owner PIN. */
  destination(): Promise<{ readonly profiles: JoinHousehold | null; readonly pin: boolean }>;
  pinMatches(pin: string): Promise<boolean>;
  /** Every document a profile library holds, read to its head; throws when it can't be read whole. */
  documents(libraryKey: string): Promise<JoinRead>;
  /** Merge into the library `libraryKey` (null: the household joined itself) and prove it holds them. */
  take(libraryKey: string | null, documents: DocumentRow[]): Promise<boolean>;
  /** Make a Kid through the Kid journal; its profile id. The same operation id never makes a second. */
  createKid(operationId: string, name: string, maximumAge: number): Promise<string>;
  /**
   * Retire a profile library of the browser's household while den-edge's head is still `head`, or (null) the
   * household itself; true once den-edge holds none under that key.
   */
  retire(libraryKey: string | null, head: number | null): Promise<boolean>;
}

export type JoinOutcome =
  | {
      readonly outcome: 'joined';
      /** The joined household's Owner, and the Kid each source Kid became; empty for a household without profiles. */
      readonly owner: string | null;
      readonly kids: Readonly<Record<string, string>>;
    }
  /** The household joined has an Owner PIN, and none (or the wrong one) was given. */
  | { readonly outcome: 'pin-required' | 'pin-wrong' }
  /** The household joined has no profiles, and a Kid here has activity it would have nowhere to go. */
  | { readonly outcome: 'refused-kids' }
  | { readonly outcome: 'unavailable' };

/** A Kid made for a joining Kid: the same operation id on every run, so a resumed join finds it rather than adds one. */
export const joinKidOperation = (sourceKid: string) => `join:${sourceKid}`;

/** A Kid with no age (unrestricted) gets the default Kid's: a Kid profile is always age-limited. */
const KID_AGE = 12;

/** A directory's live Owner and Kids, as a join reads them. */
export function joinHouseholdOf(directory: ProfileDirectoryDocument): JoinHousehold | null {
  const profile = (id: string): JoinProfile | null => {
    const entry = directory.profiles[id];
    return entry
      ? {
          id,
          key: entry.library.value.key,
          name: entry.display.value.name,
          maximumAge: entry.policy.value.maximumAge,
        }
      : null;
  };
  const owner = profile(directory.owner);
  if (!owner || directory.profiles[directory.owner]?.deleted.value) return null;
  const kids = Object.values(directory.profiles)
    .filter((entry) => entry.role === 'kid' && !entry.deleted.value)
    .map((entry) => profile(entry.id)!)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { owner, kids };
}

const sameKid = (a: JoinProfile, b: JoinProfile) =>
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && a.maximumAge === b.maximumAge;

export async function joinHousehold(io: JoinIO, pin?: string): Promise<JoinOutcome> {
  let state: JoinState = (await io.state()) ?? { version: 1, kids: {} };
  const source = await io.source();
  const destination = await io.destination();
  const joined = (): JoinOutcome => ({
    outcome: 'joined',
    owner: destination.profiles?.owner.id ?? null,
    kids: destination.profiles ? state.kids : {},
  });
  // Retired already: the run that retired it proved everything was carried first.
  if (source === 'gone') return joined();
  const keep = async (next: JoinState) => {
    await io.keep(next);
    state = next;
  };
  // What each library held when it was carried: it is retired only while den-edge's head is still that one.
  const carried = new Map<string, JoinRead>();
  const read = async (key: string) => {
    const library = await io.documents(key);
    carried.set(key, library);
    return library;
  };

  const profiles = destination.profiles;
  if (!profiles) {
    // A household without profiles takes the Owner's activity into the household, as a library kept here always
    // went; a Kid's has nowhere to go, so a Kid with any refuses the join and nothing changes.
    for (const kid of source.kids)
      if ((await read(kid.key)).documents.length) return { outcome: 'refused-kids' };
    if (!(await io.take(null, (await read(source.owner.key)).documents)))
      return { outcome: 'unavailable' };
  } else {
    if (destination.pin && !state.authorized) {
      if (!pin) return { outcome: 'pin-required' };
      if (!(await io.pinMatches(pin))) return { outcome: 'pin-wrong' };
      await keep({ ...state, authorized: true });
    }
    // A library already retired was carried before it was: nothing of it is left to take.
    const owner = await read(source.owner.key);
    if (owner.head !== null && !(await io.take(profiles.owner.key, owner.documents)))
      return { outcome: 'unavailable' };
    let kids = profiles.kids;
    for (const kid of source.kids) {
      const library = await read(kid.key);
      if (library.head === null) continue;
      let target = state.kids[kid.id];
      if (!target) {
        const taken = new Set(Object.values(state.kids));
        target =
          kids.find((candidate) => !taken.has(candidate.id) && sameKid(candidate, kid))?.id ??
          (await io.createKid(
            joinKidOperation(kid.id),
            kid.name,
            Number.isInteger(kid.maximumAge) ? kid.maximumAge! : KID_AGE,
          ));
        await keep({ ...state, kids: { ...state.kids, [kid.id]: target } });
      }
      let into = kids.find((candidate) => candidate.id === target);
      if (!into) {
        kids = (await io.destination()).profiles?.kids ?? [];
        into = kids.find((candidate) => candidate.id === target);
      }
      if (!into || !(await io.take(into.key, library.documents))) return { outcome: 'unavailable' };
    }
  }

  // The household last: until it is retired its directory still names every library left to retire.
  for (const library of [...source.kids, source.owner]) {
    const head = carried.get(library.key)?.head ?? null;
    if (head !== null && !(await io.retire(library.key, head))) return { outcome: 'unavailable' };
  }
  if (!(await io.retire(null, null))) return { outcome: 'unavailable' };
  return joined();
}
