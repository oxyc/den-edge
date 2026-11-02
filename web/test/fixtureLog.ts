// The library-log members `LibraryLogAuthority` reads its lists from (`columns`, `storedRows`, `currentSummary`,
// `documentNamed`), for a fixture whose library is held as v2 rows: those rows as the v4 documents they stand for,
// held in den-core as the real log holds its own documents (`LibraryLog.columns`).

import { blankEpisode, blankTitle } from '../src/lib/actions';
import { newestFromColumns } from '../src/lib/libraryColumns';
import { applyOps, opsFor } from '../src/lib/libraryV4';
import { rowName, type DocumentRow, type Row } from '../src/lib/wire';
import { LibraryColumns } from '../src/vendor/den-core/startup.js';

/**
 * Stamps written by a fixture's `test` device, read under a device id den-core accepts; a zero stamp (an import's,
 * when its watch has no date) as the zero stamp itself.
 */
function validDevices(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (
      value.length === 3 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number' &&
      typeof value[2] === 'string'
    )
      return value[0] === 0 && value[1] === 0
        ? [0, 0, '']
        : [value[0], value[1], 'aaaaaaaaaaaaaaaa'];
    return value.map(validDevices);
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, held]) => [key, validDevices(held)]),
    );
  return value;
}

/**
 * v2 title and episode rows as the v4 documents their writes make, in the order the rows are held. A title known only
 * at the zero stamp is an import with no date, which no write can make: its document holds the status as imported.
 */
export function documentsOf(rows: readonly Row[]): { seq: number; document: DocumentRow }[] {
  const held = new Map<string, DocumentRow>();
  for (const row of rows) {
    if (row.kind === 'rec' && row.status.at[0] === 0 && row.status.at[1] === 0) {
      const document: DocumentRow = {
        format: 4,
        kind: 'title',
        title: row.title,
        status: { value: row.status.value, at: [0, 0, ''] },
        addedAt: row.addedAt,
      };
      held.set(rowName(document), document);
      continue;
    }
    const edits =
      row.kind === 'rec'
        ? opsFor(
            row.resume.value === 0
              ? { ...blankTitle(row.title, row.addedAt), resume: row.resume }
              : blankTitle(row.title, row.addedAt),
            row,
          )
        : row.kind === 'ep'
          ? opsFor(blankEpisode(row.title, row.season, row.episode), row)
          : [];
    const valid = edits.map((edit) => ({
      ...edit,
      write: validDevices(edit.write) as Record<string, unknown>,
    }));
    for (const document of applyOps(valid, (name) => held.get(name)))
      held.set(rowName(document), document);
  }
  return [...held.values()].map((document, index) => ({ seq: index + 1, document }));
}

/**
 * The log members over `rows()`, rebuilt whenever it answers a new array (each fixture replaces its array on a write).
 * `documents` overrides how the rows become documents.
 */
export function fixtureLog(
  rows: () => Row[],
  documents: (rows: Row[]) => { seq: number; document: DocumentRow }[] = documentsOf,
) {
  let held: { rows: Row[]; documents: DocumentRow[]; columns: LibraryColumns } | undefined;
  const current = () => {
    const now = rows();
    if (held?.rows === now) return held;
    held?.columns.free();
    const docs = documents(now).map(({ document }) => document);
    const columns = new LibraryColumns();
    columns.upsert(JSON.stringify(docs));
    held = { rows: now, documents: docs, columns };
    return held;
  };
  return {
    columns: () => current().columns,
    storedRows: (): Row[] => [
      ...rows().filter((row) => row.kind === 'set'),
      ...current().documents,
    ],
    currentSummary: (now = Date.now()) => ({
      ...newestFromColumns(current().columns, now),
      at: now,
    }),
    documentNamed: (name: string) =>
      current().documents.find((document) => rowName(document) === name),
  };
}
