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
  // The versioned warm catalog cache adds 0.4 KiB gzip to the shared language seam. It prevents an English repaint
  // and avoids fetching or parsing the lazy catalog on unchanged Spanish/Swedish reloads. Allow one KiB of total
  // graph room while leaving the independently enforced English initial ceiling and catalog ceiling unchanged.
  // Structured dynamic copy replaces runtime English-sentence matching and closes generated-menu/shelf gaps. Its
  // presentation descriptors add 0.8 KiB across lazily visited screens; build-compiled phrase maps simultaneously
  // cut the opt-in catalogs by over 10 KiB and English startup remains 6.6 KiB below baseline. Give the audited
  // app graph one KiB while keeping both transfer-critical ceilings above unchanged.
  // Atlas semantic shelf headings add a bounded wire validator and typed formatter shared by browser and TV. After
  // moving all Spanish/Swedish copy into the existing lazy catalogs, the app graph is 1.0 KiB over its prior ceiling
  // while English startup remains 6.2 KiB below baseline. Allow two KiB including gzip variance; the independent
  // English-initial and opt-in-catalog ceilings remain unchanged.
  // Episode release dates from atlas (den#566) add the airing client and cache to the content worker, and to the
  // page the one-date overlay, the new-episode search and its billboard slide, the Continue Watching badge and the
  // two Home rows. Measured 4.1 KiB over main's complete graph (3.2 KiB of it in the initial graph, which stays
  // 2.7 KiB below baseline). Allow five KiB including gzip variance; the initial and catalog ceilings are unchanged.
  // Durable linked-library retirement adds 2,154 gzip bytes to startup and 3,976 bytes to the non-translation graph
  // on matched main/head builds. Receipt reconciliation and the exclusive pre-Worker fence must run before a reload
  // can relink; only the 0.35 KiB recovery notice/CSS is lazy, and it adds no request unless cleanup needs attention.
  // Allow 2.25 KiB at startup and four KiB total for that privacy boundary, including gzip variance.
  // The source-wait Worker boundary adds 135 gzip bytes to startup on the post-outage-cache parent. Request
  // ownership and the policy codec must be present with the always-loaded authority; Detail's presentation stays
  // lazy. Raise the absolute/proportional caps by the smallest rounded allowance, retaining 82 bytes on this build.
  // Current-main playback recovery adds 993 gzip bytes to startup on matched builds (4,997 -> 5,990). The receipt
  // preparation cache was moved into the existing lazy assistant chunk, saving 26 startup bytes; the remaining
  // route, generation and cancellation fences must be present before discovery or a request begins. Allow the next
  // 128-byte boundary, retaining 154 bytes on the measured build.
  // An unreachable atlas as an answer (den#724: a visitor or a profile never opened here, while the home server is
  // down) adds 176 gzip bytes to startup on matched main/head builds (202,447 -> 202,623): the discovery state, its
  // retry and the Library hook that runs it when den-edge answers again, which belong with discovery itself. The
  // message and Retry are a lazy component. Allow the next 128-byte boundary, retaining 45 bytes.
  // Visible managed-playback receipt recovery adds 243 gzip bytes to startup on matched current-main/head builds
  // (202,635 -> 202,878). Its presentation, localized copy and result controller remain in the existing assistant
  // chunk; only the session/foreground/retry fence stays before that import because splitting it would let replacement
  // authority publish stale work. Allow the next 128-byte boundary, retaining 46 bytes on the matched build.
  // Tizen 3 receipt exclusion and recovery add 205 gzip bytes at startup on matched base/head builds. The Player
  // surface stays in its existing lazy chunk; capable production builds compile out the unsupported Library handoff
  // and Owner continuation while E2E retains the injectable production path. Unsupported builds must keep the small
  // durable-ACK owner in Library because Player unmounts before that ACK or PIN transition finishes. Allow the next
  // 128-byte boundary above the retained delta, preserving 178 bytes of cross-machine gzip margin on this build.
  // The quiet update bar (top edge, held back while a player is open and drawn again when it closes, with a dismiss,
  // and keeping the navigation bar and pages' top space below it via `--bar-top`) adds 459 gzip bytes to startup and 465
  // to the complete non-translation graph on matched main/head builds (203,081 -> 203,540 and 92,153 -> 92,618). The
  // renderer must stay in the always-loaded release recovery: it runs in an old tab after a deploy has removed that
  // tab's lazy chunks. Raise the absolute/proportional startup caps and the total to the next 128-byte boundary,
  // retaining 152 and 182 bytes.
  // The browser player's A · Cinema layout adds 76 gzip bytes to startup on matched main/head builds (203,636 ->
  // 203,712): 65 are ActionMenu's two optional seams, a caller's own rows (`rows`) and where it is a sheet
  // (`sheetQuery`), in the `actions` chunk the poster menus load at startup (3,658 -> 3,723); the rest is the startup
  // phrase map. The player's pages, sections, current values and header are drawn in its lazy chunk instead. That left
  // no margin: raise the absolute/proportional startup caps to the next 128-byte boundary, retaining 108.
  if (initialDelta > Math.min(7424, Math.floor(baseline.initialGzip * 0.0378)))
    throw new Error('Browser initial JS/CSS budget exceeded');
  // Complete UI translations are opt-in chunks: neither is fetched on the higher-priority English path. Budget
  // their compressed size separately so adding copy can never disguise growth in application code, while the
  // unchanged initial-graph ceiling above remains the English startup contract.
  if (current.translationGzip > 51200) throw new Error('Lazy translation catalog budget exceeded');
  // The series poster fade (one stream-list search per series at the episode its poster asks about, with the
  // Continue Watching targets it reads) adds 1.0 KiB to the poster graph versus main, which sat 0.5 KiB under the
  // ceiling. Allow one KiB; the initial and catalog ceilings are unchanged.
  // The library held in den-core (`LibraryColumns`) adds its generated bindings to the shared library Worker and
  // the startup core, 3.1 KiB to the complete graph versus main after deleting the per-document projection, its
  // WeakMaps and the Home re-projection paths. It replaces ~22k per-document JSON calls per open: Home + History
  // 273 → 68 ms and 70 → 20 MiB. Allow four KiB including gzip variance; the initial and catalog ceilings are
  // unchanged.
  // The library kept here as one sealed snapshot and a journal (with the one-time verified conversion from one record
  // per document) adds 1.2 KiB to the library Worker versus its base. It turns a returning open's ~6,000 IndexedDB
  // records into one read: with a 6,155-document library opened whole, WebKit's shelves are ready at 222–258 ms
  // instead of 366–462 ms. Allow 1.25 KiB more; the initial and catalog ceilings are unchanged.
  // Continue kept by title in 32 parts, saved-view parts read in one transaction, and a log read that keeps only the
  // documents it does not hold add 0.3 KiB to the library Worker. An episode mark writes 8.5 KB of the library instead
  // of 55.5 KB, and each surface opens with ~60 fewer IndexedDB transactions. Allow half a KiB more; the initial and
  // catalog ceilings are unchanged.
  // An early stream list where a viewer waits (the `late` outcome, the early flag through the download query, and
  // the viewer and download lists kept apart) adds 46 bytes. A list whose slow source takes 4.1 s arrives at 1.8 s.
  // Allow a quarter KiB more; the initial and catalog ceilings are unchanged.
  // Waiting for an opening connection instead of a 1 s retry, the catalogue at once where it is Home's first row, a
  // first open that keeps everyone's picks, and a switch failure that says why add 0.3 KiB. Home's first poster on
  // WebKit iPhone moves from ~1.2 s to ~0.24 s, and a slow first visit's billboard from 23 s to 3.4 s. Allow half a
  // KiB more; the initial and catalog ceilings are unchanged.
  // Coming up (one row in place of This week and Coming back soon, with Remove), new episodes only for a caught-up
  // viewer, and following narrowed to the series the viewer is caught up on add 0.6 KiB. A series sampled once or
  // seasons behind no longer reaches Home's airing row, billboard or Continue lead. Allow one KiB more; the initial
  // and catalog ceilings are unchanged.
  // Parental-control selection recovery and retryable new-episode source searches each passed from their own base,
  // but their merged graph is 91 gzip bytes over the preceding ceiling. Allow 128 bytes for that combined baseline;
  // the initial and catalog ceilings stay unchanged. Movie reactivation remains five bytes below that merged base.
  // The bounded structured-source allowlist shared by browser, webOS and Tizen adds 220 gzip bytes: one six-character
  // guard, a fixed token check and display normalization, with no network, storage or background work. Allow a quarter
  // KiB for that audited parity contract; the initial and catalog ceilings stay unchanged.
  // Exact profile and Visitor-visit scoping for recent searches adds 94 bytes gzip to the complete graph versus
  // its release base. Keep that privacy boundary inside 128 bytes; the independent initial ceiling is unchanged.
  // Explicit Downloads opening/failure/stale/retry states add 387 bytes gzip on the merged profile-isolation base
  // and two bytes at startup. Keep that recovery UI inside half a KiB; the independent initial ceiling is fixed.
  // Kid Settings PIN service-failure, busy and retry states plus stale-attempt/profile fencing add 409 gzip bytes
  // to the complete graph and 88 bytes to startup versus v0.271.195. They add no polling or background request,
  // and busy state suppresses duplicate submissions. Allow half a KiB; the independent initial ceiling remains.
  // Superseded Explore cancellation and activity-owned, idempotent import recovery add 414 gzip bytes together
  // versus v0.271.196, only 10 bytes of it at startup. Cancellation stops obsolete provider/network work; import
  // recovery stays in lazy Settings and adds no polling. Their independently fitting graphs overlap 142 bytes past
  // the prior ceiling, so allow a quarter KiB for the reviewed combination without changing the startup limit.
  // Rejecting contradictory library-generation evidence before any consumer commits rows, heads or delete authority
  // adds 273 gzip bytes to the complete graph and 114 bytes at startup versus main. It adds no request, storage or
  // background work: one header lookup and bounded string comparison per changes page. Allow 384 bytes; the
  // independent startup ceiling remains unchanged.
  // Preserving Scout's early-answer `late` count through the library authority and rendering its accessible Detail
  // notice adds 224 gzip bytes to the complete app graph versus main and two bytes to the initial graph.
  // Keep that bounded wire/UI contract inside a quarter KiB; it adds no request, retry, polling or startup work.
  // Retaining rejected final playback progress for an exact, idempotent retry adds 678 gzip bytes to the complete
  // graph (71,406 -> 72,084) and 603 bytes at startup (1,097 -> 1,700) on matched current-main/head builds. Decoder
  // and session teardown still happen immediately, with no polling or background retry. Preserve main's existing
  // 146-byte total margin around that reviewed contract; the independent startup ceiling remains unchanged. Receipt
  // ownership and the durable command must remain in the always-loaded Library; splitting only the tiny failure
  // dialog would delay its sole recovery path and add chunk-loader overhead while leaving that authority at startup.
  // Recovery derivation cancellation and stale-attempt fencing add 261 gzip bytes to the complete graph and six
  // bytes at startup on matched current-main/head builds, after removing a dedicated cancellation error and redundant
  // attempt state. The UI stays in the existing lazy Settings/redeem chunks and the lifecycle belongs beside Worker
  // creation, so another split would add a request without removing startup code. Allow 384 bytes including gzip
  // variance; the independently enforced initial ceiling remains unchanged.
  // Settings presentation ownership, exact post-commit link reconciliation and recovery adoption add 691 gzip bytes
  // to the complete graph and 291 bytes to startup on matched parent/head builds. They add no request, polling or
  // retained work; the pairing relay request counts are unchanged. Settings and LinkTV already own lazy boundaries.
  // Splitting the small reconciliation helper again would add a request to the sole recovery action, while the join's
  // durable authority must remain with always-loaded RoutedLibrary. Allow 768 bytes including gzip variance, leaving
  // 317 bytes of total margin and 554 bytes at the independently enforced startup ceiling on this build.
  // Privacy-minimized failure reporting adds 3,032 gzip bytes to the complete graph and 417 bytes to startup on
  // matched current-main/head builds. Its 2.29 KiB queue/transport chunk is fetched only after the first reportable
  // failure; the healthy path creates no queue, retry timer or online listener. Allow 3.25 KiB including gzip variance
  // while retaining the independent startup, translation, TV-isolation, body, rate and deduplication ceilings.
  // Browsing while the home server is unreachable (den#724) adds 729 gzip bytes to the complete graph (80,250 ->
  // 80,979) and 101 bytes to startup (4,706 -> 4,807) on matched main/head builds. Almost all of it is in the shared
  // library Worker: the first page of atlas's browse answers kept in IndexedDB and handed out only when atlas cannot
  // be reached, and the saved-copy notice, whose copy the Worker sends so the page carries none of it. It adds no
  // request or background work while the server answers. It was 173 bytes past the prior ceiling, which rises by
  // 194; the startup ceiling is unchanged and this build sits 57 bytes under it.
  // Owned source lookup deadlines, cancellation, retained-list recovery and canonical den-core outcome selection add
  // 2,791 gzip bytes to the non-translation graph on the matched outage-cache parent/head hosted build, only 135
  // bytes of it at startup.
  // The wait adapter stays in the existing Library Worker beside den-core's deferred policy, so Detail never creates a
  // second Wasm realm and WebKit navigation cannot strand its module initialization. Reporting stays in the existing
  // lazy failure chunk. Splitting visible recovery state again would add a request, while request ownership belongs in
  // the Worker. Spend the old 556-byte margin and allow 2.625 KiB more, retaining 416 bytes of total margin and the
  // catalog limits.
  // Against the current-main tree, the complete non-translation graph grows 1,852 gzip bytes (83,926 -> 85,778).
  // Player deadline/notices remain in the lazy Player chunk, receipt preparation moved to the existing lazy
  // assistant chunk, and diagnostics remain lazy. That receipt split adds 28 bytes to the complete graph from the
  // module boundary while removing startup work. Session discovery and request-authority code cannot load after the
  // requests it fences. Allow the next 128-byte boundary, retaining 238 bytes on the measured build.
  // Choosing the browser transport by any fine pointer and following that choice as the device changes, with the
  // desktop bar held to one row and the up-next pair lifted clear of the timeline, adds 324 gzip bytes to the
  // complete graph (85,841 -> 86,165) and none at startup (14 bytes fewer) on matched main/head builds. All of it is
  // in the lazy Player chunk; it adds one media-query listener and no request or timer. The TV markup is left as it
  // is, which is what the duplicated up-next branch costs. Allow the next 128-byte boundary past it, retaining 107.
  // Cast in one tap (the cast page's own button laid over Den's, background discovery, the casting view with Den's
  // transport as the receiver's remote, the Cast menu and the frame's focus hand-off) adds 1,827 gzip bytes to the
  // complete graph (86,237 -> 88,064) and two at startup on matched main/head builds; all of it is in the lazy Player
  // chunk (JS 41.62 -> 43.16 kB, CSS 3.44 -> 3.68 kB). The cast page loaded beside playback is now 13.5 kB of script
  // instead of 191 kB: hls.js is fetched only when that page plays a session itself. Allow the next 128-byte
  // boundary past it, retaining 128.
  // hls.js 1.7.3 -> 1.7.4 adds 1,239 gzip bytes to the complete graph (87,895 -> 89,134) and none at startup (31
  // fewer) on matched main/head builds; all of it is the lazy hls chunk, fetched only when the in-page player plays.
  // It fixes the 1.7.0 parameter-set truncation regression and alternate-audio, WebVTT, source-switch and aborted
  // fragment reload bugs the player hits. Allow the next 128-byte boundary past it, retaining 82.
  // Outage gaps (den#724) add 989 gzip bytes to the complete non-translation graph (89,134 -> 90,123) on matched
  // main/head builds, 176 of them at startup: the unreachable-atlas state and its Retry (a 0.5 KiB lazy component
  // shared by People and the service page), the Worker telling the page den-edge answered after a failure with nothing
  // kept, and a row's pages kept on the device to its fifth. No request, timer or listener is added while the server
  // answers. Allow the next 128-byte boundary past it, retaining 117.
  // Visible receipt recovery adds 1,235 gzip bytes to the non-translation graph on matched current-main/head builds
  // (88,754 -> 89,989). Its UI and controller remain in the existing assistant chunk and its copy in existing phrase
  // catalogs. The remaining growth is the typed failure/retirement result, cancelable ACK, durable shared/local
  // readbacks and bounded status lifecycle; another lazy split cannot reduce complete-graph bytes. The current-main
  // ceiling already retains 251 bytes on the matched head, so no complete-graph allowance is added here.
  // The same contract adds 374 gzip bytes to the complete non-translation graph after that compile-time split.
  // Keep it within the next 128-byte boundary with useful variance, retaining 138 bytes against the fixed baseline.
  // Receipt recovery (#1104) and Tizen receipt recovery (#1083) were each sized against a main without the other and
  // without the outage gaps; merged together main measures 91,770 on a local production build, over both of their
  // ceilings. Allow the next 128-byte boundary past the merged measurement, retaining 134.
  // Casting a TorBox stream through Hearth's fallback adds 342 gzip bytes to the complete non-translation graph
  // (91,770 -> 92,112) and 3 at startup on matched main/head builds, all in the lazy Player and remux chunks: Hearth's
  // refusal reason named in the unchanged notice, two closed cause codes, and the uncredentialed cross-origin session
  // end. No request, timer or listener is added. Allow the next 128-byte boundary past it, retaining 48.
  // Den's own Cast receiver adds 716 gzip bytes to the complete non-translation graph (92,618 -> 93,334) and 73 at
  // startup on matched main/head builds, all in the lazy Player chunk and a castReceiver chunk that startup fetches
  // only for `?cast-receiver=`: the receiver report's schema guard, the opt-in, and the model list hidden behind it.
  // The receiver itself is its own page in the Cast build. Allow the next 128-byte boundary past it, retaining 106.
  // The browser player's A · Cinema redesign (top bar with one fixed output slot, the touch transport over the picture
  // and the mouse one in the dock, one dock row, the options' pages with current values, one toast lane, double-tap
  // and keyboard seeking, hover reveal and tooltips, the up-next card's still, title and runtime, and the timeline's
  // buffered fill) adds 6,005 gzip bytes to the complete non-translation graph (93,397 -> 99,402) and 76 at startup on
  // matched main/head builds. All but those 76 are in the lazy Player chunk (JS 43,120 -> 47,263, CSS 3,882 ->
  // 5,718), fetched only when a title plays; TV builds compile it out. Its one request, the next episode's season,
  // goes through the existing content service (the path Detail and the TV player read seasons through) 30 s before an
  // episode ends, and timers run only while the viewer acts (a click's double-click hold, the seek ripple).
  // Allow the 128-byte boundary past it that keeps cross-machine gzip variance, retaining 182.
  // Profile-locale subtitle timing adds 372 gzip bytes to the complete non-translation graph on matched main/head
  // builds (99,514 -> 99,886), 58 of them at startup (203,684 -> 203,742). The remaining code is in the lazy Player:
  // six controls/instructions, one compact and one spoken offset template, and one current-locale NumberFormat reused
  // by the menu, visible HUD and live value. Spanish/Swedish add 228 bytes to their independently bounded lazy
  // catalogs. It adds no request, timer, cue-tick or media work; allow the next 128-byte boundary, retaining 82.
  if (coreTotalDelta > 99968) throw new Error('Browser total JS/CSS budget exceeded');
}
