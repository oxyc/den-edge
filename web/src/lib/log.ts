// The library's record log on den-edge (`/lib/<id>/…`, den-spec wire/library-v2.md): read whole, and written a
// row at a time with compare-and-set. The TV writes it whenever the library changes, so it is fresher than the
// backup it hands its key over in.

import {
  compareStamps,
  deriveKeys,
  mergeEpisode,
  mergeTitle,
  open,
  rowName,
  seal,
  ZERO_STAMP,
  type LibraryKeys,
  type Row,
  type Stamp,
  type TitleRow,
} from './wire';

interface Entry {
  seq: number;
  row: Row;
}

interface Page {
  entries: { k: string; seq: number; v: string }[];
  head: number;
  more: boolean;
}

interface Batch {
  applied: { k: string; seq: number }[];
  conflicts: { k: string; seq: number; v: string | null }[];
}

/** Conflict rounds per write: another device writing the same row every time is not a thing a person does. */
const ROUNDS = 3;

export class LibraryLog {
  /** Each row as last read or written, by the name its key is the HMAC of. */
  private readonly entries = new Map<string, Entry>();

  private constructor(
    private readonly keys: LibraryKeys,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Every row in the log, or null when den-edge can't be reached. A row that doesn't open is skipped. */
  static async open(libraryKey: string, fetchImpl: typeof fetch = fetch): Promise<LibraryLog | null> {
    const log = new LibraryLog(await deriveKeys(Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0))), fetchImpl);
    let since = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(`/lib/${log.keys.id}/changes?since=${since}&limit=1000`, { headers: log.headers() });
      } catch {
        return null;
      }
      if (res.status === 404) return log; // nobody has written the library yet
      if (!res.ok) return null;
      const page = (await res.json()) as Page;
      for (const entry of page.entries) {
        try {
          const row = await open(log.keys, entry.k, entry.v);
          log.entries.set(rowName(row), { seq: entry.seq, row });
        } catch {
          // Tampered with, or sealed under another library's key.
        }
      }
      if (!page.more || page.entries.length === 0) return log;
      since = page.entries.at(-1)?.seq ?? page.head;
    }
  }

  rows(): Row[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  title(ref: { type: string; id: number }): TitleRow | undefined {
    const row = this.entries.get(`rec:${ref.type}:${ref.id}`)?.row;
    return row?.kind === 'rec' ? row : undefined;
  }

  /** The newest stamp read, so this browser's next edit is stamped after everything it has seen. */
  newestStamp(): Stamp {
    let newest = ZERO_STAMP;
    for (const { row } of this.entries.values()) {
      const stamps =
        row.kind === 'ep'
          ? [row.progress.at]
          : [row.status.at, row.resume.at, row.reaction.at, row.deleted.at, row.dismissed.at, row.episodesReset ?? ZERO_STAMP];
      for (const stamp of stamps) if (compareStamps(stamp, newest) > 0) newest = stamp;
    }
    return newest;
  }

  /**
   * Write a row, based on the sequence last seen for it. When another device wrote it first, their row comes back:
   * ours is merged on top of it and written again. Resolves to the row as stored, or null when it couldn't be saved.
   */
  async write(local: Row): Promise<Row | null> {
    let target = local;
    for (let round = 0; round < ROUNDS; round++) {
      const name = rowName(target);
      const { k, v } = await seal(this.keys, target);
      let batch: Batch;
      try {
        const res = await this.fetchImpl(`/lib/${this.keys.id}/batch`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ writes: [{ k, base: this.entries.get(name)?.seq ?? 0, v }] }),
        });
        if (!res.ok) return null;
        batch = (await res.json()) as Batch;
      } catch {
        return null;
      }
      const applied = batch.applied.find((a) => a.k === k);
      if (applied) {
        this.entries.set(name, { seq: applied.seq, row: target });
        return target;
      }
      const conflict = batch.conflicts.find((c) => c.k === k);
      if (!conflict) return null;
      if (conflict.v === null) {
        this.entries.delete(name); // what this browser remembered belongs to a log that was reset
        continue;
      }
      const theirs = await open(this.keys, k, conflict.v);
      this.entries.set(name, { seq: conflict.seq, row: theirs });
      target = merge(theirs, target);
    }
    return null;
  }

  private headers(): Record<string, string> {
    return { 'x-den-library-token': this.keys.token };
  }
}

function merge(theirs: Row, ours: Row): Row {
  if (theirs.kind === 'rec' && ours.kind === 'rec') return mergeTitle(theirs, ours);
  if (theirs.kind === 'ep' && ours.kind === 'ep') return mergeEpisode(theirs, ours);
  return theirs;
}
