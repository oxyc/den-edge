/** RFC-4180 rows, also accepting a tab-separated spreadsheet copy. A leading UTF-8 BOM is ignored. */
export function parseDelimitedRows(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.slice(
    0,
    source.search(/\r?\n/) < 0 ? source.length : source.search(/\r?\n/),
  );
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const finishField = () => {
    row.push(field);
    field = '';
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };

  for (let at = 0; at < source.length; at++) {
    const char = source[at]!;
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') {
        field += '"';
        at++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) finishField();
    else if (char === '\n') finishRow();
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) finishRow();
  return rows;
}

/** Rows keyed by a trimmed header. Extra cells and wholly empty headers are ignored. */
export function csvRecords(text: string): Record<string, string>[] {
  const [rawHeaders, ...rows] = parseDelimitedRows(text);
  if (!rawHeaders) return [];
  const headers = rawHeaders.map((header) => header.trim());
  return rows.map((row) =>
    Object.fromEntries(
      headers.flatMap((header, at) => (header ? [[header, row[at]?.trim() ?? '']] : [])),
    ),
  );
}
