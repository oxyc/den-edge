# P0 playback final qualification

Base: `73d4166d8d1b3aa426793ee65ae849673ed65a3c`.

## Corrected contracts

- `SessionServices.configure` now reads guest plugin authority synchronously so its production Svelte effect observes
  A→B and A→B→A changes. Refresh and discovery remain independently fenced; transport/5xx refresh results are
  explicit `retained-unverified` outcomes, cached guest services fail closed, and an unchanged page retries after a
  bounded five seconds.
- Managed playback awaits household receipt-key establishment at the Player intent boundary. Browsing and an empty
  receipt lane still do not enter assistant crypto. Receipt acknowledgement rechecks abort/session authority after
  apply and uses the household-scoped fetch capability captured by that originating run.
- Cast readiness is a post-`load`, per-document challenge/echo handshake. Origin and `Window` checks remain exact;
  reloads and stale queued replies cannot authorize loads or controls, and no CSP allowance was widened.
- `startSession` production 428 behavior retains the exact membership claim and body identity, adding only the
  requested IPv4 hint. Exact unheld-gid refusal and the 100-message/2,539-character receipt bounds remain unchanged.

## Qualification

- Full Vitest: 231 files passed, 3 skipped; 3,056 tests passed, 16 skipped.
- Edge receipt callback suite: 8 passed (748 unrelated tests filtered).
- Playwright: all 13 Cast-offer scenarios (the original 11 plus receipt-intent ordering and visible handshake
  timeout/retry), including deterministic reload/stale-message coverage, plus the real Svelte A→B→A authority test
  passed. One pre-existing slow-config
  fixture exposed unmocked diagnostic posts; after explicitly stubbing those existing endpoints, the focused case
  passed. This is Chromium fixture coverage, not Cast hardware qualification.
- `npm run lint` passed Prettier, ESLint, Stylelint, Svelte diagnostics, and strict Cast TypeScript.
- `npm run build` passed client/Worker verification, SSR shell, and precompression round-trip checks.
- No deployment, live homelab, stream probe, device run, TV packaging, or GitHub mutation was performed.

## Matched build evidence

Both builds used the same installed dependencies and transformed 564 client and 144 SSR modules. Clean base archive:
12.02 s complete / 2.92 s client. Worktree: 11.47 s complete / 2.77 s client. These single local samples establish no
performance gain or regression. Directly affected production chunks changed by +1,100 raw and +295 gzip bytes total:
app +866/+202, Player +111/+40, assistant +69/+29, grants +54/+24. Precompressed output changed from
4,529,566/1,649,711/1,366,175 to 4,530,666/1,649,978/1,366,460 raw/gzip/brotli bytes.

Wasm SHA-256 is identical in both builds:

- assistant: `209dbe6e4f9e9c9b6fd9072d41b58ab9c01e57628813b4725497fea285ece5bc`
- deferred: `0ca965d2b4a64628951b8a23db1b7b2cac41426907d279e1e347e65211da89bd`
- recovery: `9ce86ca99a1853e391e9e1f271c69c9e09b54a83d43f3658d02043d7c78198dd`
- startup: `ae086beee41d6474f2a60abeb8677974df72af3075f5fbbfd195a58a28184a9e`

The binary patch from the named base, excluding this self-referential report file, has SHA-256
`7ef5fa79a4655c699ce1efa62f15daf776a2e63b74f8a0404cdb1536b7cdc2ed`.

## Platform disposition and remaining work

- Browser: changed and source/unit/browser verified.
- LG/webOS and supported Samsung/Tizen: shared production paths changed; source/static/unit verified, no device run.
- Chromecast: sender and Cast document changed; Chromium contract verified, no receiver hardware run.
- iOS/iPadOS/tvOS: receipt parity remains unverified/incomplete. Den #717 is diagnostics, not receipt ownership.
- Tizen 3: grant/relay changes apply, but receipt crypto is explicitly unsupported. Ordinary in-page progress remains;
  post-page managed completion has no specific recovery/handoff UI. The focused issue draft is retained in
  `edge-1052-1054-audit.md` because this supervised run forbade GitHub posting.
- Android TV: native launcher/player receipt parity was not found in this repository path and remains unverified.

No new measured performance regression was found. The native/Tizen 3 receipt and recovery gap is the remaining
cross-platform blocker; it is not represented as completed by this snapshot.
