// Only public build assets, never API responses or encrypted library records.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import assert from 'node:assert/strict';

const extensions = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.wasm',
  '.txt',
]);
let count = 0,
  raw = 0,
  gzipped = 0,
  brotlied = 0;
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
      // Brotli beside it, at its best quality: built once, served to every browser that takes it (`web.rs`).
      const br = brotliCompressSync(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      });
      assert.deepEqual(brotliDecompressSync(br), bytes, `brotli round trip: ${file}`);
      if (br.length < gz.length) await writeFile(`${file}.br`, br);
      count++;
      raw += bytes.length;
      gzipped += gz.length;
      brotlied += Math.min(br.length, gz.length);
    }
  }
}
await compress(fileURLToPath(new URL('../dist/', import.meta.url)));
console.log(
  `precompressed ${count} assets: ${raw} → gzip ${gzipped}, brotli ${brotlied} bytes (round trips verified)`,
);
