# Navigation audit — 2026-09-12

Independent code review and browser regression checks cover router history, page retention, snapshot capture, swipe ownership, loading, and viewport behavior.

## Addressed

- Actor metadata and filmography resolve independently. Destination snapshots are now refreshed centrally from retained page content before a swipe, so a cached clone cannot omit data that arrived while hidden.
- Refreshed snapshots use the current viewport width and clamp saved scroll to the destination's current height.
- The outgoing page shadow is removed at swipe completion; it no longer darkens the landing frame until disposal.
- Separate detail/person visits have unique identities, independent scroll, and independent mounted UI state. IDs are not reused when browser history branches.
- Duplicate popstate/hashchange events are deduplicated against the requested visit, including pending updates.
- Discarded detail branches and their snapshots are released; reachable history is retained.
- Shared metadata naming deduplicates pending work and display records across retained pages, ignores superseded requests, and allows retries.
- Billboard height is measured and preserved through height-only touch viewport changes; width changes and desktop resizing update it.
- Earlier regressions remain covered: loading covers assigned to the wrong route, shared snapshot DOM, interrupted swipes, direct URL entries, negative-z detail backdrops, fresh detail scroll reset, and restored form/rail state.

## Tests

`npm test`, `npm run check`, `npm run test:e2e`. Playwright runs in CI with an isolated server and mocked APIs. Actor tests independently delay filmography, load it while hidden, rotate, repeat Forward, and compare frozen/live landing pixels. They also cover bottom-scroll clamping. Branch tests check movie IDs and duplicate-visit form/scroll state. Billboard tests assert document positions through toolbar-like viewport changes and real resizing.

## Remaining limits

- Tests use Chromium with synthetic gestures. Physical Brave/iPhone native gesture arbitration and sustained device memory/performance still require device testing.
- Data that arrives during an already-running gesture can change the destination after its preview was prepared.
- Reachable history still retains mounted pages; very long sessions can accumulate memory. Top-level tabs deliberately share their latest browsing state.
- Snapshot geometry assumes the current route/main layout. Future in-flow footers or layout containers need additional coverage.
- Service discovery is still configured by retained Library instances; metadata naming is now shared, but discovery ownership needs a separate session-lifecycle refactor.
