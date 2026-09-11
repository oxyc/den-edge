// The library's record log on den-edge (`/lib/<id>/…`, den-spec wire/library-v2.md): every row, opened. The TV
// writes it whenever the library changes, so it is fresher than the backup it hands its key over in.

import { deriveKeys, open, type Row } from './wire';

interface Page {
  entries: { k: string; seq: number; v: string }[];
  head: number;
  more: boolean;
}

/** Every row in the log, or null when den-edge can't be reached. A row that doesn't open is skipped. */
export async function readLog(libraryKey: string, fetchImpl: typeof fetch = fetch): Promise<Row[] | null> {
  const keys = await deriveKeys(Uint8Array.from(atob(libraryKey), (c) => c.charCodeAt(0)));
  const rows: Row[] = [];
  let since = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetchImpl(`/lib/${keys.id}/changes?since=${since}&limit=1000`, {
        headers: { 'x-den-library-token': keys.token },
      });
    } catch {
      return null;
    }
    if (res.status === 404) return rows; // nobody has written the library yet
    if (!res.ok) return null;
    const page = (await res.json()) as Page;
    for (const entry of page.entries) {
      try {
        rows.push(await open(keys, entry.k, entry.v));
      } catch {
        // Tampered with, or sealed under another library's key.
      }
    }
    if (!page.more || page.entries.length === 0) return rows;
    since = page.entries.at(-1)?.seq ?? page.head;
  }
}
