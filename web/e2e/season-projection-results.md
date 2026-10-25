# Season projection performance fixes

## Outcome

The four audit findings were implemented in separate commits and worktrees:

1. `05fdc998` (`aa8d2bd5` before cherry-pick) makes Continue projection changes incremental. A complete scale-3 diagnostic measured 88,140 → 9,040 `continue_entry` JSON serializations while real den-core/WASM requests remained exactly 4,520. The removed 79,100 calls were key-only serializations, not eliminated policy requests.
2. `0675b835` preserves layouts learned while an assistant projection is building. The defect was a pre-build layout snapshot being persisted after post-snapshot layouts arrived; the request key remains the exact input key while persistence merges those newly learned layouts. `cf27d4e0` adds the deterministic late-layout harness without extending the existing four-round settle gate.
3. `fe98757f` (`b9a41dfa` before cherry-pick) makes time-dependent projections reconsider future document stamps. Integration found one additional path: a deferred server completion can merge a future-stamped row after `command()` returns, so `be43fdda` rearms the absolute deadline on a changed deferred completion. Its regression performs no later selection and observes both immediate invalidation and the deadline notification; that timer also forces saved-view publication.
4. The separate native worktree commit `cab9041d` batches season projection in den-core revision `1d86e4d` (source digest `6a846563bdb767decc3b9026b9a2ebf88d92078c1fea52d1dccd955eb3ef1e74`). Five Apple slices built and 20 focused Swift tests passed; the production adapter reduced 24/100 scalar calls to one batch call while preserving scalar/row parity. No native file is imported into this web branch.

The fixed web head is `be43fdda2af71adf95b060e4093dc0ef996d1580`, based on `fae52480`. The controlled browser baseline is `fae52480` plus the identical test-only late-layout harness, recorded as `abf6bf92`; dependency locks were identical.

## Compact Continue fact candidate

Commit `2a0b997e` (including production change `e33a59ca`) targets only finished fact-only imports. For one v4 season document, that path now visits the `season_state_v4` answer a row at a time and feeds each row through the unchanged shared-core `episode_mark` operation into `ContinueSummaries`, the same latest / furthest-finished / furthest-flag selection that `compactContinueLibrary` and the Continue projector use on a whole `Library`. It does not remove any of those per-episode policy calls, and each `EpisodeRow` and its candidate `Mark` are still allocated transiently; it removes the retained episode-row array and full `LibraryFold` mark/flag maps, retaining only Continue's at-most-two winning marks per series (plus its furthest timeless flag).

Full `LibraryLog` imports, migrations and own-write retention explicitly keep the old `projectDocument` path. Those consumers retain episode rows for History/title-season detail and reuse the same document objects through `projectDocument`'s `WeakMap`; streaming there would only make the later full projection repeat work. The finished fact authority opens sealed facts on later visits, so it has no same-object row-cache consumer.

The focused benchmark is reproducible with:

```sh
cd web
npx vitest bench src/lib/libraryFactStore.bench.ts --run --reporter=verbose
```

Its 1,000-episode fixture deterministically observes the old intermediate graph holding 1,000 episode rows and 1,000 marks before compacting to two; the direct path retains only the same two marks. Three local timing samples were noisy and contradictory (stream/graph means 12.39/12.92 ms, 16.34/20.88 ms and 21.02/18.07 ms), so timing is deliberately not a gate and no latency improvement is claimed from this microbenchmark. The allocation measurements below isolate the projection/compaction algorithm, not a complete encrypted fact-store transaction or cold import. The warm browser measurements are a separate regression control.

The final opt-in allocation audit sampled five iterations of each workload per measurement (five documents for the stress case, 500 for the short-season case), alternated old/new order, and repeated each shape three times. Set `DEN_FACT_ALLOCATION_AUDIT=1`, `DEN_ALLOCATION_AUDIT=1`, `DEN_FACT_ALLOCATION_OUTPUT=<file>`, and optionally `DEN_FACT_ALLOCATION_PROFILE_DIR=<directory>` on the command above. The table below was re-measured after the streamed path was folded into `ContinueSummaries`; its summary is in `/private/tmp/claude-501/-Users-cindy-Projects-Personal-den/76eb9e2d-6503-41e2-90e7-d9223e359d71/scratchpad/alloc-final.json`. An earlier revision kept two mutable candidates per series instead of building a `Mark` for every episode: it allocated 9.19 and 11.31 MiB (47.1% and 43.6% below the old graph; profiles in `/tmp/den809-candidate-fact-allocation-final.4SvAGO`) and 8.45 and 10.90 MiB on the same machine as the table below. Sharing the selection with the whole-`Library` compactor costs about 2 MiB per workload here and keeps the browser bundle inside its budget.

| Shape                    | Old graph sampled JS allocation, median (range) | Streamed sampled JS allocation, median (range) | Median reduction |
| ------------------------ | ----------------------------------------------: | ---------------------------------------------: | ---------------: |
| One 1,000-episode season |                         16.32 MiB (16.25–17.14) |                         10.27 MiB (9.94–10.65) |            37.1% |
| 100 10-episode seasons   |                         21.81 MiB (20.33–22.38) |                        12.86 MiB (12.68–13.67) |            41.0% |

Every five-document stress sample made exactly five `season_state_v4` and 5,000 `episode_mark` calls in both strategies. Every representative sample made 500 and 5,000 respectively. These are cumulative sampled JavaScript allocations, including collected objects; they are neither peak nor retained memory and exclude WASM allocation. `season_state_v4` still materialises the full state object and `Object.entries` remains linear in episode count: the change removes the additional retained legacy `Row[]` and full Mark/flag graph, not all O(n) working memory.

### Current browser control and attribution (#809)

The exact production baseline was `de7f048b58b94ba8cb765fab728ab5679a5a255d` (`0.271.133`, including shipped #821); the candidate was `2a0b997e9c1d969ccdace1b2f18f97857faad371` (integrated locally as `f0dfe179`, with harness/report commits recorded in the raw artifacts). Both used the opt-in harness, fixed fixture day, serial browser, and three warm actual-rebuild samples. Harness hashes are recorded per run; later CPU-delta reporting does not change the allocation sampler. This warm path is a control rather than the targeted fact-only import, and it showed no material allocation shift:

| Scale | Baseline main Worker allocation, median (range) | Candidate main Worker allocation, median (range) | Baseline / candidate post-GC JS+WASM |
| ----- | ----------------------------------------------: | -----------------------------------------------: | -----------------------------------: |
| 1     |                            92.1 MiB (91.2–93.1) |                             93.6 MiB (91.8–94.3) |                       27–28 / 28 MiB |
| 3     |                         421.2 MiB (384.9–429.6) |                          430.6 MiB (393.2–431.7) |                       48–49 / 49 MiB |

Candidate scale-1 Worker build elapsed was 167–185 ms, whole publish elapsed was 1.700–1.767 s, and all-Chromium process CPU delta was 1.528–1.655 s. At scale 3 those were 465–491 ms, 2.734–2.881 s, and 3.749–3.784 s. Worker build and whole publish are elapsed durations; process CPU is a sum across Chromium processes and may exceed either. The runs were not interleaved across revisions, the first baseline scale-3 timing interval briefly overlapped another test startup, and no latency or CPU improvement is claimed.

The complete scale-3 baseline profile attributed 407.61 MiB cumulative allocation in the main Worker versus 39.19 MiB retained JS and 3.44 MiB WASM. Source-map-backed inclusive owners were JSON 69.33 MiB, encrypted local-fact decode 55.25 MiB, `applyLog` 50.14 MiB, `projectDocument` 33.92 MiB (including 1.81 MiB directly mapped inside `episodeRow`), and the fact store 71.95 MiB; these stack-inclusive buckets overlap and must not be added. The page allocated 202.29 MiB, including a 22.11 MiB lower-bound proxy at `LibraryServiceWorkerTransport.#message` for receiving the structured-cloned reply. `postMessage` calls themselves took 16.0 ms in the main Worker, while JSON handled 90,273 stringifies / 39.66 million characters and 104,291 parses / 36.77 million characters. JSON/fact decode and policy/fold graphs, rather than WebCrypto's retained result or WASM memory, are the principal remaining allocation targets.

Reproduce source attribution after a profiled browser run with:

```sh
node --stack-size=65500 scripts/analyze-allocation-profile.mjs \
  <profile.json> <copied-dist-assets-directory> > attribution.json
```

Focused verification at `2a0b997e` passed 233 tests across `log.test.ts` and seven projection/authority suites, plus Svelte/TypeScript checking and ESLint. The parity fixture pins sparse specials, equal-time ordering, newest versus furthest watched episodes, timeless flags, clears applied by season reset, resume seconds/device, future-stamp ownership through `manifest.newest`, and the unchanged legacy-row path.

### Current candidate verification

The combined local branch at `80471902` passed the full Vitest suite: 2,687 tests passed and 12 were skipped. Svelte checking reported zero errors and warnings; targeted ESLint and Prettier checks passed. The production implementation received independent review, followed by a coordinator review of the cache-preservation delta. These checks were local, not hosted CI, and no physical old-device benchmark was performed.

After rebasing onto `92de3d0a` (main after #825 and #827, neither touching this work's code), `npm run lint` passed and Vitest passed 2,695 tests with 12 skipped. On the previous base, `77e77248`, the 299 Playwright tests in the e2e specs that mention Continue Watching or history passed with no retries.

### Streamed Home projection: measured and dropped

A follow-up candidate (`8198e29b`, rebased as `47994877`) projected Home straight from the stored v4 documents (`projectHomeLibraryView`) instead of from `LibraryLog.rows()`. It is not on this branch. It is preserved, with the measurement below, on `oxyc/den809-home-stream-dropped`.

The reason is that `rows()` is the projection History reads too. Before the candidate, a library Worker that served Home's selections and then History built that projection once, and History reused it through `rows()`'s per-version cache. With the candidate, Home's stream did not fill that cache, so History then built the whole projection again. Measured in Node with `libraryFactStore.bench.ts` on the evidence branch, test `Home then History in one library Worker`. The household had 6,000 documents projecting to 18,000 rows. Each sample was five iterations, with three samples per strategy in alternating order:

| Work                                     | Sampled JS allocation, median (range) | Elapsed, median (range) | `title_state` / `season_state_v4` / `episode_mark` calls |
| ---------------------------------------- | ------------------------------------: | ----------------------: | -------------------------------------------------------: |
| Home then History, one shared projection |               454.6 MiB (452.2–457.7) |  1,342 ms (1,327–1,356) |                                 10,000 / 20,000 / 80,000 |
| Home then History, streamed Home first   |               440.2 MiB (434.9–441.3) |  1,980 ms (1,967–1,995) |                                 20,000 / 40,000 / 80,000 |
| Home only, projection and full fold      |               420.8 MiB (418.4–423.7) |  1,335 ms (1,314–1,373) |                                 10,000 / 20,000 / 80,000 |
| Home only, streamed                      |               246.5 MiB (242.3–248.1) |  1,226 ms (1,218–1,250) |                                 10,000 / 20,000 / 80,000 |

Streaming cut Home-only allocation by 41%. When History followed, though, every title and season policy call ran twice: elapsed time went up 48%, while allocation went down only 3%.

The browser shows where that tradeoff falls. In the Chromium phone budget run (`BIG_LIBRARY_SCALE=1`, `DEN_FIXTURE_NOW=1792713600000`), a returning Home visit is served from the saved view: it folds 0 documents on both revisions, so the candidate never runs there. It runs only once the full log is promoted. The table gives the largest library Worker's cumulative sampled allocation per visit, n=3 per revision, with revisions alternating:

| Visit                        | Without candidate (`4e95cacb`), median (range) | With candidate (`47994877`), median (range) |
| ---------------------------- | ---------------------------------------------: | ------------------------------------------: |
| Home during a rebuild        |                         116.0 MB (108.8–118.7) |                      109.6 MB (108.8–112.5) |
| Watchlist (History promoted) |                         118.8 MB (114.6–123.2) |                      114.8 MB (110.8–118.7) |
| Returning Home               |                 2.3–5.7 MB, 0 documents folded |              2.5–6.4 MB, 0 documents folded |

The browser allocation differences are within run-to-run range. The Worker's `foldMs` cannot compare the two, because the candidate's timer covered its own projection while the parent's started after `rows()` had built it. Host one-minute load during these runs was 10–31 on 10 cores, so no browser latency is claimed. Raw logs are in `/private/tmp/claude-501/-Users-cindy-Projects-Personal-den/76eb9e2d-6503-41e2-90e7-d9223e359d71/scratchpad/issue-809/runs/`.

Before Home's projection is streamed again, History needs to stop depending on a full `rows()` projection, or both need to come from one pass. Otherwise Home's saving becomes History's cost.

### Home from one pass, History from `rows()` alone

The calls doubled because the dropped candidate streamed through `forEachProjectedRow`, which skips `projectDocument`'s per-document `WeakMap`. The current change (`perf/809-one-pass`) keeps both on `rows()`, whose per-version cache already holds each document's den-core answer. `projectHomeLibraryView(rows)` folds the title rows, then feeds each well-formed episode row into `ContinueSummaries` with its series reset, dropping what a reset would drop; it never builds the full `LibraryFold`. History no longer asks for Home's view: it reads the same cached `rows()`, so each document goes through den-core once per Worker in whichever order the two are opened. (A first version read the stored documents directly; the e2e fixtures' cut-down logs offer only `rows()`, so it was moved onto `rows()`, which also covers old-format rows.) `libraryLogAuthority.test.ts` pins that: History alone, Home alone and Home then History each make 2 `title_state` and 2 `season_state_v4` calls, and the test fails (4 `season_state_v4`) on the uncached stream.

The Node measurement is `Home and History in one library Worker` in `libraryFactStore.bench.ts`. It uses the same 6,000-document / 18,000-row household, five iterations per sample, and three samples per strategy, with old and new alternating:

```sh
cd web
DEN_FACT_ALLOCATION_AUDIT=1 DEN_ALLOCATION_AUDIT=1 DEN_JOURNEY_ALLOCATION_OUTPUT=<file> \
  npx vitest bench src/lib/libraryFactStore.bench.ts --run
```

| Work                                           | Sampled JS allocation, median (range) | Elapsed, median (range) | `title_state` / `season_state_v4` / `episode_mark` |
| ---------------------------------------------- | ------------------------------------: | ----------------------: | -------------------------------------------------: |
| Home only, before: `rows()` and full fold      |               426.4 MiB (423.7–428.5) |                       — |                           10,000 / 20,000 / 80,000 |
| Home only, after: `rows()` and one pass        |               327.0 MiB (317.7–328.4) |                       — |                           10,000 / 20,000 / 80,000 |
| History only, before: `rows()` and Home's fold |               468.4 MiB (464.7–479.2) |                       — |                           10,000 / 20,000 / 80,000 |
| History only, after: `rows()`                  |               247.3 MiB (244.1–249.5) |                       — |                                10,000 / 20,000 / 0 |
| Home then History, before                      |               469.7 MiB (466.7–477.6) |                       — |                           10,000 / 20,000 / 80,000 |
| Home then History, after                       |               369.8 MiB (369.6–375.4) |                       — |                           10,000 / 20,000 / 80,000 |

Measured on the `rows()` version (`a6e7112d`). History-only allocation fell 47%, and it makes no `episode_mark` calls, because it no longer builds Home. Home-only allocation fell 23%, and Home then History 21%. Call counts are unchanged in every journey. These match the first (stored-documents) version's figures within about 1%. Elapsed time is not reported: the host's load was 12–39 on 10 cores and two samples stalled for over 15 minutes, so timings from this run are not evidence; an earlier run on the first version measured History-only at 1,421 → 783 ms. Home's saving is smaller than the dropped candidate's 41% because each season's projection is held in `rows()`'s cache for History to reuse; the variant that streamed past that cache is the one that doubled the calls.

The browser comparison is incomplete. Chromium phone budget runs (`BIG_LIBRARY_SCALE=1`, `DEN_FIXTURE_NOW=1792713600000`, `BIG_LIBRARY_DEBUG=1`, alternating `2400843a` main and this branch) finished once on main and twice on the branch. The other three timed out while the host's one-minute load rose to 31–121 on 10 cores from unrelated work. The largest library Worker's cumulative sampled allocation on Watchlist was 118.1 MB on main and 106.1 / 108.6 MB on the branch. Home during a rebuild was 114.2 MB on main and 106.2 / 104.6 MB on the branch. Watchlist's `documentsFolded` reads 13,748 on main and 6,156 on the branch: it now counts stored documents rather than projected rows, and History no longer records a fold. Returning surfaces stayed at 2–7 MB with 24 documents folded on both. With n=1 on main, this is not a measured improvement.

## Historical verification (previous shipped changes)

Focused integration:

```sh
npm test -- --run src/lib/libraryLogAuthority.test.ts \
  src/lib/libraryAssistantAuthority.test.ts src/lib/homeLibraryView.test.ts \
  src/lib/library.test.ts src/lib/finishedLibraryViewAuthority.test.ts
```

All 135 tests in five files passed.

Full web verification:

```sh
npm test
npm run check && npm run lint
```

Vitest passed 2,678 tests in 202 files, with 12 tests and two files skipped. Prettier, ESLint, Stylelint, both Svelte checks, and strict cast TypeScript checking passed; Svelte reported zero errors and zero warnings.

## Browser provenance

- Fixture day: `DEN_FIXTURE_NOW=1792713600000` (`2026-10-23T00:00:00.000Z`).
- Mac16,1, Apple M4 (10 logical CPUs), 24 GiB, macOS 27.0 build 26A428.
- Node 24.19.0, npm 11.17.0, Playwright 1.64.1, Chromium 156.0.8078.4.
- Serial execution, one browser test at a time. Each sample opened a new page and Workers in the same warm browser context and origin stores.
- Returning surfaces used the existing 4× page throttle; dedicated Workers were unthrottled. Actual rebuilds were unthrottled and had `projectionDelayMs=0`; the 6,000 ms artificial hold was absent.
- The settle gate retained its existing maximum of four rounds. Every recorded normal scale-1/3 run converged after two.

The current diagnostic-only tooling is tracked and remains off unless `DEN_ALLOCATION_AUDIT=1` is set. The tables below are historical measurements of earlier revisions and retain their original commands and provenance; they are not the candidate comparison above.

Normal scale-1/3 command, run once for each revision and scale:

```sh
DEN_FIXTURE_NOW=1792713600000 DEN_LATE_LAYOUT_BUILD_MS=0 \
DEN_ALLOCATION_AUDIT=1 DEN_AUDIT_REPEATS=1 BIG_LIBRARY_SCALE=<1|3> \
BIG_LIBRARY_DEBUG=1 npx playwright test --config playwright.budgets.config.ts \
  --grep 'Chromium phone'
```

### Normal actual rebuilds (n=1)

| Scale | Revision | Outcome | Build elapsed | Wall elapsed | Main Worker cumulative sampled allocation | Post-GC retained JS + WASM | Chromium process RSS snapshot |
| ----- | -------- | ------- | ------------: | -----------: | ----------------------------------------: | -------------------------: | ----------------------------: |
| 1     | baseline | built   |        174 ms |     1,687 ms |                                 101.9 MiB |                     25 MiB |                 563,019,776 B |
| 1     | fixed    | built   |        176 ms |     1,694 ms |                                  91.5 MiB |                     26 MiB |                 594,067,456 B |
| 3     | baseline | built   |        482 ms |     2,633 ms |                                 373.0 MiB |                     45 MiB |                 649,904,128 B |
| 3     | fixed    | built   |        473 ms |     2,666 ms |                                 271.2 MiB |                     45 MiB |                 696,958,976 B |

The scale-3 Watchlist's main Worker cumulative sampled allocation was 333.3 MiB baseline and 269.5 MiB fixed. Its post-GC retained total was 64 MiB baseline and 63 MiB fixed. These are n=1 samples, so they do not establish a timing or retained-memory improvement.

“Allocated” is cumulative sampled allocation, including collected objects; it is not peak resident memory. “Retained” is post-collection JavaScript heap plus retained WASM. RSS is a one-time sum of live Chromium processes and is not app-only. The Worker-reported `buildMs` is elapsed duration, not CPU time; the audit separately retained cumulative process CPU counters. Host one-minute load at the actual samples ranged from 5.05–5.52 at scale 1 and 5.44–6.10 at scale 3.

### Continue mechanism diagnostic (scale 3, n=1)

The comparable actual-rebuild-only profiles used:

```sh
DEN_FIXTURE_NOW=1792713600000 DEN_LATE_LAYOUT_BUILD_MS=0 \
DEN_ALLOCATION_AUDIT=1 DEN_ALLOCATION_PROFILE=1 \
DEN_ALLOCATION_REBUILD_ONLY=1 DEN_AUDIT_REPEATS=1 BIG_LIBRARY_SCALE=3 \
BIG_LIBRARY_DEBUG=1 npx playwright test --config playwright.budgets.config.ts \
  --grep 'Chromium phone'
```

| Revision | Measured library Worker `continue_entry` serializations | Real WASM requests | Key-only serializations | Worker cumulative sampled allocation |
| -------- | ------------------------------------------------------: | -----------------: | ----------------------: | -----------------------------------: |
| baseline |                                                  88,140 |              4,520 |                  83,620 |                            552.5 MiB |
| fixed    |                                                   9,040 |              4,520 |                   4,520 |                            405.2 MiB |

Both profiles were complete, with no missing targets or protocol errors; this also verifies the previously unverified `Page.enable` path. Each diagnostic kept one retired nested projection Worker alive so its profile could be read. Diagnostic retained memory (75/76 MiB) and RSS therefore do not represent normal lifetime and are excluded from the normal table. This identifies a key-stringification reduction with unchanged real policy request counts; parity tests, not counts alone, check result semantics. It is not an app-wide 2× claim.

### Late-layout convergence

The deterministic comparison used `DEN_LATE_LAYOUT_BUILD_MS=1000`, scale 1, and zero audit repeats so only household creation and the unchanged settle gate ran. Both baseline and fixed passed with `[Home=current, Watchlist=built sent0]` followed by `[current,current]`. Because the delayed baseline also converged on this fast host, the browser delay is not causal evidence for the original intermittence. The exact publication persistence race is covered by the authority regression, while the historical intermittent scale-3 non-convergence was not reproduced in these controlled runs.

All normal scale-1/3 actual rebuilds returned `built`, never `too_large`. Expected offline-harness proxy refusals for unused playback or incremental fallback routes appeared in logs, but all reported runs passed. No WebKit rerun, deployment, installation, or physical-device interaction was performed.

### Earlier native-batching browser sample

The report previously recorded the following scale-1 full-journey samples on the same host against pre-batch den-edge source `607797fe`. They are retained as historical evidence and are not used as the controlled web baseline above.

| Journey            | Strategy               | Allocated MiB | Retained heap MiB | WASM MiB | Fold/build ms | Content/episodes ms |
| ------------------ | ---------------------- | ------------: | ----------------: | -------: | ------------: | ------------------: |
| Watchlist history  | repeated episode calls |         128.9 |              11.3 |      1.2 |          90.4 |               2,264 |
| Watchlist history  | batched seasons        |         113.5 |              11.3 |      1.2 |         101.7 |               1,361 |
| Projection rebuild | repeated episode calls |         155.6 |              10.6 |      2.3 |         6,222 |                 443 |
| Projection rebuild | batched seasons        |         139.1 |              10.5 |      2.3 |         6,202 |                 267 |

The Watchlist Worker folded 13,724 derived rows from 6,132 hydrated documents in both historical samples. Batching removed 15.4 MiB (11.9%) of sampled boundary allocation in Watchlist and 16.5 MiB (10.6%) in rebuild without changing the retained graph; the single-run latency differences were not attributed to batching. The complete-Worker 113.5 MiB remainder includes opening, projection, folding, and reply rather than episode-row objects alone.

The historical rebuild values of 6,222/6,202 ms include an injected 6,000 ms `PHONE_PROJECTION_MS` hold. They are not CPU measurements or undelayed core-build durations and must not be compared directly with the current 174–482 ms build measurements.

## Raw artifacts

- Baseline scale 1 normal: `/tmp/den809-baseline-scale1.g8mmhR`
- Fixed scale 1 normal: `/tmp/den809-fixed-scale1.uarAgH`
- Baseline scale 3 normal: `/tmp/den809-baseline-scale3.lfISEg`
- Fixed scale 3 normal: `/tmp/den809-fixed-scale3.hxkTTd`
- Baseline scale 3 complete diagnostic: `/tmp/den809-baseline-scale3-diagnostic2.AhQDxg`
- Fixed scale 3 complete diagnostic: `/tmp/den809-fixed-scale3-diagnostic.WAycUy`
- Baseline delayed layout: `/tmp/den809-baseline-late-layout.0if6kv`
- Fixed delayed layout: `/tmp/den809-fixed-late-layout.FVp6UH`
- Archived diagnostic-only harness patch: `/tmp/den809-final-diagnostic-harness/harness.patch`
- Current `de7f048b` scale-1 normal n=3: `/tmp/den809-de7f-scale1-normal.rda9Ep`
- Current `de7f048b` scale-3 normal n=3: `/tmp/den809-de7f-scale3-normal.yofPxl`
- Current `de7f048b` scale-3 complete profile and attribution: `/tmp/den809-de7f-scale3-profile.GWKQQj`
- Candidate `2a0b997e` scale-1 normal n=3: `/tmp/den809-candidate-scale1-normal.5HirUX`
- Candidate `2a0b997e` scale-3 normal n=3: `/tmp/den809-candidate-scale3-normal.NUKG1P`
- Candidate targeted fact allocation n=3 with raw profiles: `/tmp/den809-candidate-fact-allocation-final.4SvAGO`

Each browser artifact directory contains the raw log, Playwright results copied before the next reset, exact revision, and hashes of the lock and harness files. Two initial command attempts that passed a test filename through the npm wrapper found no tests; their preserved paths are `/tmp/den809-baseline-late-layout.CTcORh` and `/tmp/den809-baseline-late-layout.H8h6sL`. The first complete profiler attempt (`/tmp/den809-baseline-scale3-diagnostic.UdWAro`) profiled every target but its request counter instrumented only the page bundle, not Worker bundles; it is superseded by `diagnostic2` and excluded from the request table.

The attempted whole-household import profile at `/tmp/den809-de7f-scale3-import-profile.XSKB6A` crossed multiple navigations, detached its earlier Workers, and was interrupted rather than reported. It is excluded from every result above; the bounded algorithm profiles and warm single-page browser profiles are complete.
