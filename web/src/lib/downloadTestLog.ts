// A library log for the download queue's tests: the rows, their seqs, and den-edge's compare-and-set, in memory.
// `write` merges as the real log does on a conflict; `writeAt` is exact and refuses a stale base, as den-edge does.

import type { BrowserClock } from './clock';
import { releaseIdentity } from './downloadRows';
import type { LibraryLog } from './log';
import type { TitleSource } from './titleSources';
import { syncPolicy } from './syncCore';
import { rowName, type Row, type SettingsRow, type Stamp } from './wire';

export interface TestLog {
  log: LibraryLog;
  rows: Map<string, { seq: number; row: SettingsRow }>;
  /** Another device's write landing: the row as given, at the next seq. */
  land(row: SettingsRow): void;
  writes: string[];
  /** Another window of the same browser: its own log over the same den-edge. */
  window(): LibraryLog;
}

export function testLog(rows: SettingsRow[] = []): TestLog {
  let head = 0;
  const held = new Map<string, { seq: number; row: SettingsRow }>();
  const writes: string[] = [];
  const put = (row: SettingsRow) => held.set(rowName(row), { seq: ++head, row });
  for (const row of rows) put(row);
  const newest = (): Stamp => {
    let latest: Stamp = [0, 0, ''];
    for (const { row } of held.values())
      for (const value of Object.values(row.values))
        if (value.at[0] > latest[0] || (value.at[0] === latest[0] && value.at[1] > latest[1]))
          latest = value.at;
    return latest;
  };
  const open = () =>
    ({
      readOnly: false,
      wireMinimum: 4,
      rows: (): Row[] => [...held.values()].map(({ row }) => row),
      settings: (name: string) => held.get(`set:${name}`)?.row,
      seqOf: (name: string) => held.get(name)?.seq ?? 0,
      newestStamp: newest,
      async write(row: Row) {
        const local = row as SettingsRow;
        const name = rowName(local);
        const seen = held.get(name)?.row;
        const merged = seen ? syncPolicy<SettingsRow>({ op: 'merge', a: seen, b: local }) : local;
        put(merged);
        writes.push(`write ${name}`);
        return merged;
      },
      async writeAt(row: SettingsRow, base: number) {
        const name = rowName(row);
        if ((held.get(name)?.seq ?? 0) !== base) {
          writes.push(`conflict ${name}`);
          return false;
        }
        put(row);
        writes.push(`writeAt ${name}`);
        return true;
      },
    }) as unknown as LibraryLog;
  return { log: open(), rows: held, land: put, writes, window: open };
}

/** A release as `parseSources` reads one, with scout's `attributes` as given. */
export function source(
  filename: string,
  attributes: Record<string, unknown> = {},
  ticket = filename,
): TitleSource {
  const url = `/scout/p/${ticket}`;
  return {
    filename,
    url,
    label: filename,
    cached: attributes.cached as boolean | undefined,
    seeders: attributes.seeders as number | undefined,
    size: attributes.sizeBytes as number | undefined,
    badges: [],
    languages: [],
    probed: false,
    identity: releaseIdentity(url, filename),
    attributes,
  };
}

/** A clock for one device, issuing stamps after `now`. */
export function testClock(device: string, now = () => Date.now()): BrowserClock {
  let last: Stamp = [0, 0, device];
  return {
    device,
    issue(at = now()) {
      last = at > last[0] ? [at, 0, device] : [last[0], last[1] + 1, device];
      return last;
    },
    see(stamp) {
      if (stamp[0] > last[0] || (stamp[0] === last[0] && stamp[1] > last[1]))
        last = [stamp[0], stamp[1], device];
    },
  };
}
