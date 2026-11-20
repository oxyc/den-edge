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
  // Holding a start for den-remux's media lead adds no startup code, but the lazy Player chunk's new name moves
  // startup 9 gzip bytes (7,421 -> 7,430 on matched main/head builds) against a main 2 bytes under the proportional
  // cap. Raise both caps to the next 128-byte boundary, retaining 122.
  // A profile's explicit playback-source policy adds 326 gzip bytes to startup on matched current-main/head builds
  // (203,804 -> 204,130). Its menu and AirPlay recovery remain in the existing lazy Settings/Player chunks; only the
  // profile projection and strict cross-client codec stay in the initial graph so every host sees the same choice.
  // Allow the next 128-byte boundary, retaining 74 bytes without a dependency, request or background task.
  // Owner-only Kid creation (#940) adds 2,128 gzip bytes to startup on matched base/head builds after placing the
  // complete form in a new lazy chunk. Admission, durable recovery and the shared Worker task contract stay eager so
  // every browser/TV host observes one authority before the form loads. AGENTS.md records the full consolidation.
  // Authority-scoped series-release recall then adds 52 gzip bytes at startup on matched current-main/head builds
  // (206,135 -> 206,187): the compact authority tuple and Player remount key which prevent replaced authority from
  // publishing delayed recall. The digest, codec and source lookup remain lazy. The existing cap retains 65 bytes.
  // Exact-current Owner PIN replacement/removal (#1145) adds 88 gzip bytes at startup on matched base/head builds.
  // The UI stays in lazy Settings and Tizen 3 compiles it out; only the versioned command and write authority remain
  // with the Worker that must reject old clients and stale rows before Settings can recover. Allow the smallest
  // 128-byte boundary containing the reviewed graph, retaining 102 bytes.
  // Browser-owned persistent title approval (#530) adds 388 bytes at startup on matched fc04556c/head builds. The
  // exact mutation authority must stay with the eagerly mounted profile coordinator/Library boundary; the TV-only
  // handoff was consolidated into the already lazy Detail chunk. Allow the smallest 128-byte boundary; the tighter
  // proportional bound retained 7 bytes on that matched graph. Exact clean main after the separately measured Cast
  // and Settings authority fixes is 10,214 bytes over the fixed baseline: 61 bytes past that proportional bound but
  // still 26 bytes inside the existing 10,240-byte absolute ceiling. Align the proportional side with that unchanged
  // absolute boundary using the smallest five-decimal factor that reaches it; no shipped byte or other budget moves.
  // ActionMenu opening on the side with room and capping its height there (a long list scrolls above its trigger
  // instead of covering it) puts the initial graph at 10,300 bytes over the baseline in CI: ActionMenu is in the
  // `actions` chunk the poster menus load at startup. Allow the next 128-byte boundary and the smallest five-decimal
  // factor that reaches it, retaining 68 bytes.
  // The player's Episodes list adds 317 gzip bytes at startup on matched main/head builds (10,308 -> 10,625): ActionMenu
  // placing an open menu again when its rows change size and opening on the row marked current (+123 in `actions`),
  // and the series' aired seasons Library hands the player (+190). The list itself stays in the lazy Player chunk;
  // its rows are a plain link or button because `<svelte:element>` pulled 1,640 bytes of runtime into the shared
  // startup chunk. Allow the next 128-byte boundary and the smallest five-decimal factor that reaches it, retaining
  // 127 bytes.
  // Scoping retained availability to the exact household, profile and Scout (#1156) adds 275 gzip bytes at startup on
  // matched main/head builds (10,744 -> 11,019): the authority admission `ProfileSession` makes before it configures
  // the household, and the reset and restore that fence a verdict, request or timer to one authority. They sit with
  // `Availability` in the eagerly mounted profile/session graph, since the fence must hold before any poster asks.
  // Allow the smallest 128-byte boundary containing it and the smallest five-decimal factor that reaches it,
  // retaining 117 bytes.
  if (initialDelta > Math.min(11136, Math.floor(baseline.initialGzip * 0.05671)))
    throw new Error('Browser initial JS/CSS budget exceeded');
  // Complete UI translations are opt-in chunks: neither is fetched on the higher-priority English path. Budget
  // their compressed size separately so adding copy can never disguise growth in application code, while the
  // unchanged initial-graph ceiling above remains the English startup contract.
  // The subtitle menu's "needs Den Remux" copy in Swedish and Spanish measured 51,262 against matched main's 51,187
  // (+75), which sat 13 bytes under the 50 KiB ceiling. Allow the next 128-byte boundary after the one that leaves
  // 66 bytes, retaining 194.
  // The missing-library notice and its "Open Linked devices" action (#1212) in Swedish and Spanish measure 51,549
  // against matched main's 51,439 (+110), which sat 17 bytes under this ceiling: no localized notice fits. Allow the
  // next 128-byte boundary, retaining 35.
  // The profile switcher's own copy (#1158) in Swedish and Spanish measured 51,689 in CI against main's 51,549 (+140,
  // main at d4d42ac1): the two new PIN-field labels, the parameterised Owner-PIN and Kid age lines, and the `profile`
  // fallback. The first draft measured 51,749; dropping the two fragments the parameterised Owner-PIN line replaced
  // removed 60. The catalogs are already lazy, and every phrase left is visible or spoken copy. Allow the next 128-byte
  // boundary, retaining 23.
  // Settings retries (#1045) add one phrase, "Saved, but not shown.", for a profile language that was saved but
  // could not be presented: 51,722 in CI against main's 51,689 (+33, main at 20463fa0). The SIMKL notes reuse
  // existing phrases. Allow the next 128-byte boundary, retaining 118.
  if (current.translationGzip > 51840) throw new Error('Lazy translation catalog budget exceeded');
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
  // Casting the release a receiver can play when Hearth refuses the one playing here (one more ask, no release named)
  // brings the complete non-translation graph to 99,636 in CI, all in the lazy Player chunk; no request is added
  // unless Hearth refuses with `torbox_receiver_unsupported`. Allow the next 128-byte boundary past it, retaining 76.
  // Den's Cast receiver in the cast report (what its TV plays, its firmware and device type, its player's error
  // codes) brings the graph to 100,030 on a local build, in the lazy Player and castReceiver chunks only; it adds no
  // request. Allow the next 128-byte boundary past it, retaining 66.
  // AirPlay's single-owner handoff and privacy-safe event evidence add 386 gzip bytes to the complete graph on
  // matched current-main/head builds (825,827 -> 826,213), 368 of them in the existing lazy Player chunk, while
  // startup shrinks by 10 bytes. It reuses the existing video, Cast report transport and WebKit listeners, adding no
  // request, timer, polling or CSS. Splitting the synchronous target/availability state would add a chunk request at
  // the moment the system picker opens and cannot reduce the complete graph. Allow the next boundary with useful
  // cross-machine variance, retaining 185 bytes on this build.
  // A direct AirPlay target that stays connected but advances no media now falls back once to Den Remux after a
  // bounded 12 s watch. It adds 230 gzip bytes to the complete graph on matched v0.271.222/head builds (826,213 ->
  // 826,443), with the existing lazy Player chunk growing 251 bytes and startup moving five. The one timer
  // exists only while an active, playing AirPlay target has a TorBox session and is cleared on progress, pause,
  // disconnect, replacement and teardown. A separate lazy boundary would add a request during the handoff while the
  // synchronous WebKit event and live video element are required. Allow 256 bytes, retaining 211 on this build.
  // A re-invited guest keeping their own Hearth settings (the held credentials sent with a redeem, leaving the grants
  // it supersedes) and the host's "own settings" mark and revoke warning bring the graph to 101,232 in CI, in the
  // grants module and the lazy Sharing settings; one leave request is added, only on a redeem that supersedes a grant.
  // Allow the next 128-byte boundary past it, retaining 144.
  // Learning a remote link from playback (raised only on two clean sessions, the history kept through a probe, a
  // short stall in the opening seconds not held against it) and the 60 s start hold bring the graph to 101,467 in
  // CI, in the remux and playback-stats modules; it adds no request, timer or storage key. Allow 256 bytes, since the
  // next 128-byte boundary would retain only 37: 165 retained.
  // Merging the Kid direct-read authority brings the combined graph to 101,667. Its measured consolidation and
  // rejected lazy alternatives are recorded in AGENTS.md; allow the next 128-byte boundary, retaining 93.
  // Watchlist desired-state Retry adds 643 gzip bytes to the complete graph while startup shrinks by two bytes.
  // It stays in the existing lazy Watchlist chunk; another split would add a request after failure without reducing
  // the complete graph. Allow the next 128-byte boundary, retaining 73 bytes on the matched build.
  // Holding a start for den-remux's media lead (`prebufferLead`), with a bit-rate countdown and a still-buffer rule
  // that waits for an overdue segment, adds 247 gzip bytes on a local build, all in the lazy Player chunk; it adds no
  // request, timer or storage. On top of the Retry above that is about 102,574; allow the next 128-byte boundary.
  // The same source policy adds 1,039 gzip bytes to the non-translation graph on those matched builds. The 309-byte
  // recovery stays in Player and the 121-byte control in SettingsNav, both already-lazy boundaries; splitting their
  // small shared enums again would add loader overhead. Allow the next 128-byte boundary, retaining 60 bytes.
  // Household-sharing escrow recovery adds 760 gzip bytes to the complete non-translation graph and 69 at startup
  // on matched current-main/head builds. Its authority fencing, durable readback and Retry stay in the existing lazy
  // Settings and grants chunks; another split would add a request on the failure path without reducing this total.
  // Subtitle-timing profile localization then adds 432 bytes on matched c78408e9/head builds. Its synchronous HUD
  // copy and number formatting stay in the existing lazy Player, while non-English copy is already catalog-lazy;
  // another split adds a request without reducing this graph. Allow the smallest 128-byte boundary, retaining 1 byte.
  // Canonical provider-variant routing and locale-owned Home/hover reuse add 480 bytes on matched current-main/head
  // builds. Detail/services/Settings remain in their existing lazy graph; Home's 80-byte locale-generation fence
  // stays beside the top-level provider-row readiness it owns, because moving it into lazy HomeCatalogue would
  // duplicate or delay the same authority used by radar rows/captions. Another split adds a request before a badge
  // becomes usable. Allow the smallest 128-byte boundary containing the reviewed graph, retaining 70 bytes;
  // translation catalogs remain unchanged.
  // Optional title-facts recovery then adds 1,607 bytes on matched a819734f/head builds, split between the existing
  // lazy Detail and content-service Worker boundaries. Another split adds a request on the failure path or Worker
  // startup and cannot reduce the complete graph. Allow the smallest 128-byte boundary, retaining 112 bytes.
  // Owner-only Kid creation (#940) adds 4,433 gzip bytes to the complete non-translation graph; 2,059 bytes are the
  // separately lazy form, while the remaining admission/recovery authority is shared by the startup page and Worker.
  // The final matched current-main/head measurement and smallest combined boundary are recorded in AGENTS.md.
  // Authority-scoped series-release recall then adds 1,160 gzip bytes to the complete non-translation graph on
  // matched current-main/head builds (116,438 -> 117,598), 1,141 in the existing lazy Player chunk and 58 in the
  // eager app chunk, partly offset by 39 bytes elsewhere. Another boundary cannot reduce this complete-graph total
  // and would add a request before the first session lookup. Allow the next 128-byte boundary, retaining 34 bytes.
  // Compound profile-key reset (#941) adds 2,423 gzip bytes to the complete non-translation graph while startup
  // shrinks by 73 bytes. Its 1,121-byte page coordinator is separately lazy; the remaining Settings presentation,
  // link handoff and Worker protocol must bracket that coordinator so reload can recover before the form opens.
  // Allow the smallest 128-byte boundary containing the reviewed graph, retaining 40 bytes on the matched build.
  // Assistant recovery (#1278) stays in the existing lazy Connect/Settings boundaries, while acknowledged durable
  // readback stays with the shared Worker that owns those rows. Reduced Tizen compiles the connector/queue runtime
  // out entirely. Matched measurements and consolidation are in AGENTS.md; allow the smallest 128-byte boundary.
  // Exact-current Owner PIN authority (#1145) adds 1,432 gzip bytes to the complete non-translation graph. Its form
  // remains in lazy Settings; command admission, exact-row CAS and durable replay prevention remain in the Worker.
  // Another split would add an authority request and duplicate the row guard. Allow the smallest 128-byte boundary,
  // retaining 7 bytes on the matched build.
  // Exact clean current main independently measures 121,434 here, 3,802 above its committed 117,632 ceiling; #1282
  // owns the reproducibility defect. Recalibrate clean main separately to 121,472 (38-byte margin), then account for
  // #530's matched +756-byte non-translation delta. Allow the smallest 128-byte boundary, retaining 50 bytes.
  // The player's Episodes list adds 1,945 gzip bytes to the complete non-translation graph on matched main/head builds
  // (120,408 -> 122,353), nearly all in the lazy Player chunk: the list, its season reader and its styles. CI measured
  // the same head at 122,509 (#1282's run-to-run variance), so allow the boundary above CI's figure plus one more,
  // retaining 115 bytes there.
  // The Episodes list's series-backdrop fallback for missing stills and its current-season chip reveal add 162 gzip
  // bytes to the complete graph on matched base/head builds (122,647 -> 122,809), all in the lazy Player chunk. CI
  // measured the head at 122,754; allow the next 128-byte boundary above it, retaining 126 bytes.
  // The Episodes list's near-view still loader (an IntersectionObserver per still, with its srcset) and the menu's
  // skip of a repeated placement, on a main that has since gained #1322 and #1343, measured 123,061 in CI. All of the
  // list's share is in the lazy Player chunk. The next boundary would leave 75 bytes against #1282's run-to-run
  // variance, so allow the one after it, retaining 203 bytes.
  // Indexed Kid-create receipts measured 123,549 against exact-main's 123,259 (+290). The retained delta is the
  // crash-safe v1 migration and sealed indexed lookup, already inside the lazy administration/Worker graph; another
  // split cannot reduce the complete graph. Keep startup's cap unchanged and allow the next 128-byte boundary.
  // Retired Owner-split cleanup measured 123,896 against that 123,549 main (+347) after consolidating Vault reads
  // recovered 108 gzip bytes. Its exact-key bounded scan is post-foreground in a lazy chunk; moving it eager would
  // exceed startup's remaining 13-byte margin. Keep that cap unchanged and allow the second 128-byte boundary: the
  // first leaves only 8 bytes against measured variance, while this one retains 136 bytes before final compaction.
  // Away from home, one transport (#1366): the player drives the cast page's video by message, and the cast page draws
  // its own AirPlay and (on an iPhone) fullscreen buttons in the top bar's hole. Measured 124,589 locally, about 690
  // over main's recorded 123,896, in the lazy Player chunk and the separately served cast page; startup is unchanged.
  // The next boundary would leave 83 bytes against #1282's run-to-run variance, so allow the one after it, retaining
  // 211.
  // Physical LG startup attribution adds 16 gzip bytes to the initial graph and 44 bytes to the complete graph on
  // matched base/head builds (207,111 -> 207,127; 124,681 -> 124,725). The two fixed phase names and their calls must
  // be eager: a lazy boundary would begin after the profile handover/metadata flushes they identify and add a request
  // to the measured path. Both existing caps stay unchanged; the complete-graph cap retains 75 bytes.
  // Subtitles never switching the source, and AirPlay asking for the receiver-safe stream at once on an HEVC release,
  // measured 124,863 locally against matched main's 124,681 (+182), all in the lazy Player chunk: the subtitle menu's
  // explicit Den Remux switch and its notice, and the codec lookup. Startup is unchanged (10,715 -> 10,712). With the
  // LG attribution above that is about 124,907; allow the second boundary past the first one's 65 bytes, retaining 149.
  // The auto-skip grace period (#1208: the Apple TV's 8 s visible countdown, cancelled by playback interaction)
  // measured 125,524 against matched main's 125,051 (+473, main at 0321382f), all in the lazy Player chunk: the pure
  // decision, the countdown and its once-spoken notice, the pause/seek cancellation, the reset fences and the desktop
  // Skip button's missing `pointer-events`. It adds no timer, request or listener beyond the existing media-event
  // handlers; startup moves 10,719 -> 10,725. Allow the smallest 128-byte boundary containing it, retaining 44.
  // Bounded Reel requests and the fail-closed relay fallback (#1257/#1258) measured 126,176 against matched main's
  // 125,524 (+652, main at 2d35b3f1). About 133 is the deadlines and fallback; about 520 is the poorer compression of
  // the transport negotiation as its own lazy chunk, loaded only when a carried trailer is first tried. That split
  // takes startup 10,725 -> 10,529 (-196). Allow the smallest 128-byte boundary containing it, retaining 32.
  // Consuming a segment scan the current play started (#1201) measured 126,292 against matched main's 126,176 (+116,
  // main at 053a769e), all in the lazy Player chunk: up to three re-asks of a miss on the existing progress tick, the
  // episode fence and den-edge's settled-miss header. No timer, listener or startup code; startup moves 10,529 ->
  // 10,512. Allow the smallest 128-byte boundary containing it, retaining 44.
  // The missing-library notice (#1212) measured 127,187 against matched main's 126,292 (+895, main at 251484fd). Only
  // the typed `refused-start` status is on the startup path (+20: its getter and codec case); the notice copy, its
  // Linked devices action and the row reveal are a lazy `MissingLibraryNotice` chunk (+666), fetched only while a
  // library is refused, plus its registry entry, load effect and slot. Startup moves 10,512 -> 10,642 (appMain +102;
  // the new chunk renumbers the shared import map, about +3 in each of six other startup chunks); the eager-copy draft
  // measured +206. The Worker adds +40. It adds no request outside that state, timer or polling. Allow the smallest
  // 128-byte boundary containing it, retaining 45.
  // Localizing the profile switcher (#1158) measured 127,242 in CI against main's 127,190 (+52, main at d4d42ac1):
  // the `i18n.phrase`/`format` calls around the switcher's existing English copy and the Kid/Visitor/Owner description
  // helper. They render in the always-mounted switcher and its dialog; moving the dialog behind a dynamic import would
  // add a request to every open and still count here. Allow the next 128-byte boundary, retaining 118.
  // Settings retries (#1045) measured 127,629 in CI against main's 127,284 (+345, main at 20463fa0), all in the lazy
  // Settings route: the profile-preference and SIMKL-disconnect generation/session fences and their Retry controls.
  // Startup measures 206,967, within its cap. Allow the smallest 128-byte boundary containing it, retaining 115.
  // Ending a read held before first paint (#1378) measured 127,771 against main's 127,740 (+31, main at 5a8eef62): one
  // branch in the library Worker's foreground-ready handler, which every Worker graph carries. A lazy split cannot
  // reduce it. Startup is unchanged within chunk-hash churn. Allow the smallest 128-byte boundary, retaining 101.
  // Keeping the old link when a legacy key-reset marker is unreadable (#1252) measured 127,951: one storage probe and one
  // branch in `forgetMoved`, in the links module every Browser graph carries. A lazy split cannot reduce it. Startup is
  // unchanged. Allow the next 128-byte boundary, retaining 49.
  // Scoping retained availability to the exact household, profile and Scout (#1156) measured 128,142 against matched
  // main's 128,000 (+142, main at e3940b7e): the same authority admission, reset and restore as the startup note
  // above, plus the shared local authority digest that release memory now takes from the same module. Startup carries
  // it, so a lazy split cannot reduce the complete graph. Allow the next 128-byte boundary, retaining 114.
  // An audio choice on a TorBox stream that names no tracks (#1419) measured 128,173 against matched main's 128,142
  // (+31, main at 1184de9d), all in the lazy Player chunk: the Audio section's switch to Den Remux and the dock button
  // shown for it. It reuses the existing switch and its labels; one phrase is new. It fits, retaining 83.
  // AirPlay's way back (#1202) measured MEASURED against matched main's BASE (+DELTA, main at 71f28b69), all in the
  // lazy Player chunk: the AirPlay bar (Close, Stop AirPlay through the shared Button), the settled wireless loss and the
  // reload at the receiver's position back on this device, and the TorBox switch where the cast page offers no AirPlay.
  // Drafts measured +658 (five phrases) and +530 (a custom Stop button); reusing `Button` removed its CSS. It must sit
  // with the element's WebKit events it answers; another split would add a request mid-playback. The TorBox switch's
  // label reuses `player.switchTo`. Allow the smallest 128-byte boundary containing it, retaining MARGIN.
  if (coreTotalDelta > CEILING) throw new Error('Browser total JS/CSS budget exceeded');
}
