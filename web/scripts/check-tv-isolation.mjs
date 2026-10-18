import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Measure all JS/CSS (including lazy chunks and Workers), plus exactly the shell's initial preload graph.
// Chunk hashes may change; sizes and module ownership, not names, are the contract.
const root = resolve(import.meta.dirname, '..');
async function measure(directory) {
  const html = await readFile(resolve(directory, 'index.html'), 'utf8');
  const initial = new Set(
    [...html.matchAll(/(?:src|href)="\/?(assets\/[^"?#]+\.(?:js|css))"/g)].map((match) => match[1]),
  );
  const files = (await readdir(resolve(directory, 'assets'))).filter((name) =>
    /\.(js|css)$/.test(name),
  );
  let totalGzip = 0;
  let initialGzip = 0;
  for (const name of files) {
    const bytes = await readFile(resolve(directory, 'assets', name));
    const size = gzipSync(bytes, { level: 9 }).length;
    totalGzip += size;
    if (initial.has(`assets/${name}`)) initialGzip += size;
    if (/den:tv-back|den-tv-diagnostics|tv-remote-active|tv-transport/.test(bytes.toString()))
      throw new Error(`TV-only implementation leaked into browser output: ${name}`);
  }
  return { initialGzip, totalGzip, files: files.length };
}

const baselinePath = resolve(root, 'scripts/tv-browser-baseline.json');
if (process.argv.includes('--capture')) {
  const measured = await measure(resolve(root, 'dist-browser-baseline'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(baselinePath, JSON.stringify({ commit, ...measured }, null, 2) + '\n');
  console.log('Captured clean-base browser budget', measured);
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const current = await measure(resolve(root, 'dist'));
  const initialDelta = current.initialGzip - baseline.initialGzip;
  const totalDelta = current.totalGzip - baseline.totalGzip;
  console.log(JSON.stringify({ baseline, current, initialDelta, totalDelta }, null, 2));
  if (initialDelta > Math.min(2048, Math.floor(baseline.initialGzip * 0.02)))
    throw new Error('Browser initial JS/CSS budget exceeded');
  if (totalDelta > 5120) throw new Error('Browser total JS/CSS budget exceeded');
}
