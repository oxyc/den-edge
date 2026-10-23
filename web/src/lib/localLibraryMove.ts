// A library kept only in this browser moving into its household (den#295): what the household and Owner libraries,
// read back from den-edge, must hold before the copy kept here is retired. Both sides are compared as their v4
// documents and settings, so moving never turns a document into a lossy title or episode projection.

import { compareStamps, isDocument, mergeDocument, rowName, type Row, type Stamp } from './wire';

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

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, held: unknown) =>
    held && typeof held === 'object' && !Array.isArray(held)
      ? Object.fromEntries(
          Object.entries(held).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : held,
  );

/**
 * Names the documents or settings in `expected` that den-edge's `held` rows do not account for.
 */
export function unaccounted(expected: readonly Row[], held: readonly Row[]): string[] {
  const missing: string[] = [];
  const heldByName = new Map(held.map((row) => [rowName(row), row]));
  for (const row of expected) {
    const name = rowName(row);
    const have = heldByName.get(name);
    if (isDocument(row)) {
      if (!have || !isDocument(have) || canonical(mergeDocument(row, have)) !== canonical(have))
        missing.push(name);
    } else if (row.kind === 'set') {
      if (SELF_WRITTEN.has(row.name)) continue;
      const values = have?.kind === 'set' ? have.values : {};
      if (!Object.entries(row.values).every(([key, value]) => stands(values[key], value)))
        missing.push(name);
    }
  }
  return missing;
}
