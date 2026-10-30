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
  let translationGzip = 0;
  for (const name of files) {
    const bytes = await readFile(resolve(directory, 'assets', name));
    const size = gzipSync(bytes, { level: 9 }).length;
    totalGzip += size;
    if (/^(?:es|sv)-.*\.js$/.test(name)) translationGzip += size;
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
  return { initialGzip, totalGzip, translationGzip, files: files.length };
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
  const translationDelta = current.translationGzip - (baseline.translationGzip ?? 0);
  const coreTotalDelta = totalDelta - translationDelta;
  console.log(
    JSON.stringify(
      { baseline, current, initialDelta, totalDelta, translationDelta, coreTotalDelta },
      null,
      2,
    ),
  );
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
  // Revision-bound History pagination adds one compact encrypted checkpoint/index implementation to the shared
  // library Worker and a small demand-paging path to the lazy Library screen. Its measured 22.7 KiB total delta
  // replaces 0.9 MiB whole-history replies at 10k titles and cuts the representative cold path about 4x. Allow the
  // reviewed 6 KiB increase while keeping the initial graph and TV-only isolation limits unchanged.
  // Desktop multi-tab ownership adds a 1.8 KiB lazy transport and about 3 KiB of broker/recovery code to the one
  // existing worker artifact. It removes one whole 149 KiB-gzip worker realm for every additional same-library tab
  // and measured about 49% less two-tab worker heap. Allow 6 KiB for that reviewed root-level saving; TV builds
  // compile the broker and transport out, and the initial browser ceiling remains unchanged.
  // Home startup phase attribution and deferring the service/catalogue implementation add 2.5 KiB to the complete
  // lazy graph versus their base, while removing 2.5 KiB from the initial graph. Give that reviewed split two KiB
  // of remaining ceiling, including cross-platform gzip variance; its optional chunk is fetched only after the
  // first personal shelf has painted.
  // The compact hero projection, one-pass Home indexes and exhaustive startup attribution add 1.0 KiB total versus
  // main while keeping the initial graph 9.6 KiB below the fixed baseline. Allow two KiB for that shared root-level
  // work: it removes repeated snapshot scans, full-detail messages and speculative startup parsing on every client.
  // The one-way catalogue readiness gate adds under 0.2 KiB while preventing Browse from loading twice as provider
  // defaults and names settle. Keep one KiB of cross-machine gzip room for that correctness fix; this revision still
  // removes more than 13 KiB from the initial graph and does not relax its ceiling or the TV-only implementation scan.
  // The atomic profile-preference boundary and explicit three-state subtitle contract add 2.8 KiB to the complete
  // graph versus their merged base. Allow three KiB for that reviewed validation/core bridge while retaining the
  // original baseline and the tighter, independently measured initial-graph ceiling.
  // Performance parity with tvOS (den#443) adds 1.4 KiB to the complete graph versus main (0.8 KiB of it initial):
  // search answers streamed to the page with a repeat-search cache, a held idle library read that stays off the write
  // lane and pauses under the player, the TV's focus-dwell warm, per-title standings, and the per-screen stalls report.
  // Allow two KiB for that reviewed work; the initial ceiling and the TV-only scan are unchanged.
  // Encrypted playback receipts add one foreground-only drain to the shared assistant chunk and progress authority.
  // After sharing its HTTP queue machinery, the complete lazy graph is 220 bytes over the previous ceiling while
  // the initial graph remains 11.6 KiB smaller than baseline. Allow one KiB without changing the initial limit.
  // Multilingual presentation adds two independently lazy message catalogs and the profile/content language seam.
  // Its complete graph is 4.3 KiB above its parent, while the English initial graph is 1.9 KiB smaller; Tizen's
  // conditional Intl fallback is compiled out of this browser build. Allow four KiB for those opt-in catalogs and
  // keep the independently enforced initial ceiling unchanged so English startup cannot spend this allowance.
  // Persisting an unpaired browser's language and translating the Home/detail primary action add 0.25 KiB after
  // trimming, while fixing the route/reload journey that the original allowance did not test. Keep that correction
  // inside a 0.5 KiB increment; the English initial graph remains over 9 KiB below the fixed baseline.
  if (initialDelta > Math.min(2560, Math.floor(baseline.initialGzip * 0.01325)))
    throw new Error('Browser initial JS/CSS budget exceeded');
  // Complete UI translations are opt-in chunks: neither is fetched on the higher-priority English path. Budget
  // their compressed size separately so adding copy can never disguise growth in application code, while the
  // unchanged initial-graph ceiling above remains the English startup contract.
  if (current.translationGzip > 51200) throw new Error('Lazy translation catalog budget exceeded');
  if (coreTotalDelta > 51200) throw new Error('Browser total JS/CSS budget exceeded');
}
