// A library kept only in this browser moving into its household (den#295): what the household and Owner libraries,
// read back from den-edge, must hold before the copy kept here is retired. Compared as the page shows it (a title's
// standing, rating and resume point; each episode's progress; each setting), not as stored, because the copy kept here
// is in the v2 or v3 form and the libraries on den-edge are v4 documents.

import { applyLog, emptyLibrary } from './library';
import {
  compareStamps,
  isDocument,
  rowName,
  type DocumentRow,
  type Row,
  type Stamp,
  type TitleRow,
} from './wire';

/** Whether rows kept here hold anything a person kept: not only what the page writes by itself. */
export function keptSomething(rows: readonly Row[]): boolean {
  return rows.some((row) => row.kind !== 'set' || !SELF_WRITTEN.has(row.name));
}

/** Rows the page writes with no one keeping anything: this device's entry, and a recovery code (never moved). */
const SELF_WRITTEN = new Set(['devices', 'recovery']);

/** `held` stands for `wanted`: it is the same, or den-edge holds a newer write of it. */
function stands(
  held: { value: unknown; at: Stamp } | undefined,
  wanted: { value: unknown; at: Stamp },
): boolean {
  if (!held) return false;
  const order = compareStamps(held.at, wanted.at);
  return order > 0 || (order === 0 && JSON.stringify(held.value) === JSON.stringify(wanted.value));
}

const TITLE_FIELDS = ['status', 'reaction', 'deleted', 'dismissed', 'resume'] as const;

/**
 * The names of the rows in `expected` (what was written from the copy kept here) that `held` (what den-edge holds, read
 * back with `LibraryLog.heldRows`) does not account for; empty when everything is there. Tracker events are carried as
 * the edits they record, so the title they changed accounts for them.
 */
export function unaccounted(expected: readonly Row[], held: readonly Row[]): string[] {
  const missing: string[] = [];
  const heldByName = new Map<string, Row>();
  for (const row of held)
    if (row.kind === 'rec' || row.kind === 'set') heldByName.set(rowName(row), row);
  const deliveries = held.filter(
    (row): row is DocumentRow => isDocument(row) && row.kind === 'delivery',
  );

  for (const row of expected) {
    if (row.kind === 'rec') {
      const have = heldByName.get(rowName(row)) as TitleRow | undefined;
      if (!have || !TITLE_FIELDS.every((field) => stands(have[field], row[field])))
        missing.push(rowName(row));
    } else if (row.kind === 'set') {
      if (row.name.startsWith('tracker-event:') || SELF_WRITTEN.has(row.name)) continue;
      const have = heldByName.get(rowName(row));
      const values = have?.kind === 'set' ? have.values : {};
      if (!Object.entries(row.values).every(([key, value]) => stands(values[key], value)))
        missing.push(rowName(row));
    } else if (row.kind === 'snt') {
      const [, type, id] = row.target.split(':');
      const delivered = deliveries.some(
        (document) =>
          document.provider === row.provider &&
          document.account === row.account &&
          document.title.type === type &&
          String(document.title.id) === id,
      );
      if (!delivered) missing.push(rowName(row));
    }
  }

  // Episodes as the page shows them: a resume point or a watched mark, whatever form each library keeps them in.
  const episodes = (rows: readonly Row[]) =>
    applyLog(
      emptyLibrary(),
      rows.filter((row) => row.kind === 'ep' || row.kind === 'wat' || row.kind === 'rec'),
    );
  const want = episodes(expected);
  const have = episodes(held);
  const key = (m: { type: string; id: number; season: number; episode: number }) =>
    `${m.type}:${m.id}:${m.season}:${m.episode}`;
  const marks = new Map(have.marks.map((mark) => [key(mark), mark]));
  for (const mark of want.marks) {
    const held = marks.get(key(mark));
    if (
      !held ||
      held.updatedAt < mark.updatedAt ||
      (held.updatedAt === mark.updatedAt && held.fraction !== mark.fraction)
    )
      missing.push(`episode:${key(mark)}`);
  }
  for (const flag of want.flags?.keys() ?? [])
    if (!have.flags?.has(flag) && !marks.has(flag)) missing.push(`episode:${flag}`);
  return missing;
}
