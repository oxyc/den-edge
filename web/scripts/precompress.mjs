// Only public build assets, never API responses or encrypted library records.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const extensions = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.wasm', '.txt']);
let count = 0, raw = 0, compressed = 0;
async function compress(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await compress(file);
    else if (entry.isFile() && extensions.has(extname(file))) {
      const bytes = await readFile(file);
      const gz = gzipSync(bytes, { level: 9 });
      if (gz.length >= bytes.length) continue;
      assert.deepEqual(gunzipSync(gz), bytes, `gzip round trip: ${file}`);
      await writeFile(`${file}.gz`, gz);
      count++; raw += bytes.length; compressed += gz.length;
    }
  }
}
await compress(fileURLToPath(new URL('../dist/', import.meta.url)));
console.log(`gzip: ${count} assets, ${raw} → ${compressed} bytes (round trips verified)`);
