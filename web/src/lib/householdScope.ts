import { syncPolicy } from './syncCore';
import { rowName, type Row, type SettingsRow } from './wire';

/** den-core's `profile_household_write` answer (profiles-v1 §2): what a profile-aware household may take of a row. */
export type HouseholdWrite =
  { effect: 'allow' | 'refuse' } | { effect: 'restrict'; values: SettingsRow['values'] };

/**
 * The household write rule (profiles-v1 §2), shaped as den-core's `profile_household_write` answers it, so that op
 * replaces this body once it is vendored. Until then it is den-core's `profile_scoped_name` with the split's own
 * partition: `set:prefs` keeps what `profiles_partition_preferences` leaves in the household, `set:keys` everything
 * but `simkl`.
 */
export function profileHouseholdWrite(row: {
  name: string;
  values?: SettingsRow['values'];
}): HouseholdWrite {
  const { name } = row;
  if (
    name.startsWith('title:') ||
    name.startsWith('season:') ||
    name.startsWith('dlv:') ||
    name.startsWith('set:deliver:') ||
    name.startsWith('set:handoff:') ||
    name === 'set:trackers' ||
    name === 'set:assistant-applied'
  )
    return { effect: 'refuse' };
  if (name !== 'set:prefs' && name !== 'set:keys') return { effect: 'allow' };
  let values: SettingsRow['values'];
  if (name === 'set:prefs')
    values = syncPolicy<{ household: SettingsRow['values'] }>({
      op: 'profiles_partition_preferences',
      values: row.values ?? {},
    }).household;
  else {
    const { simkl: _owner, ...household } = row.values ?? {};
    values = household;
  }
  return Object.keys(values).length ? { effect: 'restrict', values } : { effect: 'refuse' };
}

/**
 * A browser's own library split for a household (den#295): the half of `row` its profile library takes, or null when
 * all of it is the household's. Activity goes whole (titles and episodes in any form, tracker events, and every row
 * the household refuses), `set:prefs` and `set:keys` as their profile half (the profile preference keys; `simkl`).
 * `den.maturityCeiling` is in neither half: a profile's policy lives in the directory.
 */
export function profileScoped(row: Row): Row | null {
  if (row.kind !== 'set' || row.name.startsWith('tracker-event:')) return row;
  const name = rowName(row);
  if (name !== 'set:prefs' && name !== 'set:keys')
    return profileHouseholdWrite({ name }).effect === 'refuse' ? row : null;
  const values =
    name === 'set:prefs'
      ? syncPolicy<{ owner: SettingsRow['values'] }>({
          op: 'profiles_partition_preferences',
          values: row.values,
        }).owner
      : Object.fromEntries(Object.entries(row.values).filter(([key]) => key === 'simkl'));
  return Object.keys(values).length ? { ...row, values } : null;
}

/** `row` as a profile-aware household takes it: whole, cut to its household half, or null when it is refused. */
export function householdScoped(row: Row): Row | null {
  const name = rowName(row);
  const answer = profileHouseholdWrite(
    row.kind === 'set' && (name === 'set:prefs' || name === 'set:keys')
      ? { name, values: row.values }
      : { name },
  );
  if (answer.effect === 'restrict') return { ...(row as SettingsRow), values: answer.values };
  return answer.effect === 'allow' ? row : null;
}
