# Season projection full-journey measurements

Recorded 2026-10-23 on an Apple M4 Mac16,1 (24 GB), macOS 27.0, Node 24.19.0, and Google Chrome, with den-edge
`607797fe` as the pre-batch source. Both scale-1 samples used the generated `big-library.mjs` household, a returning
visit, a cold page/Worker, a warm application cache, and the Chromium phone profile at 4× page CPU. Chromium's page
throttling does not throttle Worker CPU.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  npx playwright test --config playwright.budgets.config.ts \
  big-library-budgets.spec.mjs --grep Chromium --workers=1
```

`allocated` is Chrome HeapProfiler sampling for the named `libraryServiceWorker`, including collected objects.
`heap` is retained JS after collection, `WASM` is its live linear memory, and the fold time is the Worker's own
`selection:history` metric. These are single full-journey samples, not benchmark medians.

| Journey            | Strategy               | Allocated MB | Retained heap MB | WASM MB | Fold/build ms | Content/episodes ms |
| ------------------ | ---------------------- | -----------: | ---------------: | ------: | ------------: | ------------------: |
| Watchlist history  | repeated episode calls |        128.9 |             11.3 |     1.2 |          90.4 |               2,264 |
| Watchlist history  | batched seasons        |        113.5 |             11.3 |     1.2 |         101.7 |               1,361 |
| Projection rebuild | repeated episode calls |        155.6 |             10.6 |     2.3 |         6,222 |                 443 |
| Projection rebuild | batched seasons        |        139.1 |             10.5 |     2.3 |         6,202 |                 267 |

The Watchlist Worker still folded 13,724 derived rows from 6,132 hydrated documents in both runs. Batching therefore
removed about 15.4 MB (11.9%) of sampled boundary allocation without changing the retained projection graph. The
rebuild removed 16.5 MB (10.6%) with effectively unchanged retained memory and overall assistant-build time. The
single-run latency differences are reported but are not attributed to batching.

`BIG_LIBRARY_SCALE=3` was also attempted with the same command and environment. The fixture did not reach the
measurement phase: its assistant projection failed to settle after all four setup rounds. Scaled operation results
for 24 and 100 episode seasons, including CPU, serialized bytes, call count, and native allocation, are checked into
den-core beside its reproducible `bench/season-projection.mjs` and `season_projection_memory.rs` benchmarks.

The remaining 113.5 MB is the complete Worker sample (opening, projection, fold, and reply), not a measurement of
episode-row objects alone. Since the retained row graph did not grow or shrink and existing history/detail/log
consumers still require those legacy rows, this change does not force a second compact representation without a
profile that attributes a material remainder to disposable episode rows.
