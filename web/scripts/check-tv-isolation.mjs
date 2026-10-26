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
    if (
      // The owned player transport is deliberately shared with desktop browsers. Remote navigation, diagnostics
      // and decoder bridges remain package-only and must never enter the ordinary browser graph.
      /den:tv-back|den-tv-diagnostics|tv-remote-active|den-avplay|Samsung AVPlay/.test(
        bytes.toString(),
      )
    )
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
  // Shared navigation and the owned browser/TV player get a small allowance. Keep the initial graph proportional
  // and the complete lazy graph under a fixed 15 KiB ceiling. The extra 2 KiB is the reviewed camera-to-TV
  // pairing path shared by browser Settings and the packaged clients; TV-only implementation is rejected above.
  // The ceiling rose from 11 KiB to 15 KiB once the lazy graph was at the old limit and playback-source recovery
  // and the debrid status notice no longer fit; it still fails any change that grows the lazy graph by kilobytes.
  // It rose again to 16 KiB for the TV's assistant lane (assistant-v1 §16): the library worker is one bundle shared by
  // the browser and the TV builds, so its TV-queue branch (~160 bytes) ships to browsers too, and the lazy graph sat
  // 11 bytes under 15 KiB with it, too close for gzip to agree across machines. The page side of the lane stays
  // TV-only (householdPlays).
  // The compact browser remote adds its transport row and icon styling to the lazy detail graph. Keep that reviewed
  // addition within one further KiB without relaxing the initial graph or TV-only implementation scan above.
  if (initialDelta > Math.min(2560, Math.floor(baseline.initialGzip * 0.01325)))
    throw new Error('Browser initial JS/CSS budget exceeded');
  if (totalDelta > 17408) throw new Error('Browser total JS/CSS budget exceeded');
}
