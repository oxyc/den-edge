import { compareStamps, rowName, type Row, type SettingsRow, type Stamp } from './wire';

/** Explicit user actions each occupy an independent encrypted row, so permanent history cannot overflow a title.
 * Tracker imports never call this function. An event records intent, not proof of tracker delivery.
 */
export interface TrackerEvent {
  schema: 1;
  id: string;
  at: Stamp;
  before: Row;
  after: Row;
  changes: Record<string, { before: unknown; after: unknown }>;
}

export function recordTrackerEvent(before: Row, after: Row, at: Stamp, id: string = crypto.randomUUID()): SettingsRow | null {
  if (rowName(before) !== rowName(after) || after.kind === 'set') return null;
  const fields = after.kind === 'rec' ? ['status', 'reaction', 'deleted'] : ['progress'];
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of fields) {
    const prior = before[field];
    const next = after[field] as { at?: Stamp } | undefined;
    if (next?.at && compareStamps(next.at, at) === 0 && JSON.stringify(prior) !== JSON.stringify(next)) {
      changes[field] = { before: prior, after: next };
    }
  }
  if (Object.keys(changes).length === 0) return null;
  const event: TrackerEvent = { schema: 1, id, at, before, after, changes };
  return { kind: 'set', schema: 2, name: `tracker-event:${id}`, values: { event: { value: { string: JSON.stringify(event) }, at } } };
}

export function trackerEvent(row: Row): TrackerEvent | null {
  if (row.kind !== 'set' || !row.name.startsWith('tracker-event:')) return null;
  try {
    const stored = row.values.event;
    if (!stored?.value || !('string' in stored.value)) return null;
    const event = JSON.parse(stored.value.string) as TrackerEvent;
    if (event.schema !== 1 || row.name !== `tracker-event:${event.id}` || event.after.kind === 'set'
      || rowName(event.before) !== rowName(event.after) || compareStamps(event.at, stored.at) !== 0) return null;
    return event;
  } catch { return null; }
}
