# P0 playback final qualification

Base: `73d4166d8d1b3aa426793ee65ae849673ed65a3c`.
Joined-contract follow-up base: `d75e209815621f4f634ec7ca72df56736ec67e40`.
Round-3 blocker base: `2312314d19aaa7682795b7d894dcaffa46f4f244`.
Round-4 Astra blocker base: `4a71f19511af2d982a976f526047794700d4977f`.
Round-5 Astra blocker base: `0d88c9011b9b67ea2e2d3eda87619d8d7d88bd97`.

## Current-main integration follow-up

The branch was rebased through #1068 (`74860492`) and then corrected for production-semantic failures found by two
exact-head Astra reviews:

- Route discovery now distinguishes network/non-2xx/schema/parse failure from an authoritative empty route table.
  Only failure retries; a valid empty table still starts shared-install and same-origin Atlas/Reel fallback. The
  production-adapter regression uses two 503 responses before success and proves discovery does not begin early;
  the independent empty-table regression proves fallback discovery is not suppressed. If all three bounded route
  attempts fail, discovery then proceeds once with the safe empty fallback so unrelated same-origin/shared services
  remain usable without introducing continued polling.
- Atlas publication now requires an acknowledgement from the current configuration generation. The A acknowledged
  -> B pending -> A replacement race therefore reconfigures the content worker back to A instead of trusting an
  obsolete retained publication.
- Managed receipt preparation has a three-second, attempt-owned deadline around the complete callback, including its
  first lazy import and Library Service reconnect. Reconnect waits also observe task cancellation. A failure visibly
  explains degraded progress recovery and continues playback; a failed preparation is not cached, so the next play
  retries. The underlying Dropbox PUT is independently bounded to five seconds.
- Grant refresh is foreground-gated and bounded to three total attempts (initial, five seconds and thirty seconds),
  then stops until its authority inputs change. It no longer polls every five seconds for the life of the page.

The matched #1068 build measured 4,997 startup and 83,926 complete non-translation gzip bytes over the fixed
baseline. This follow-up measures 5,990 and 85,778 respectively: +993 startup and +1,852 complete. Receipt
preparation was moved into the existing lazy assistant chunk; that removes 26 startup bytes but adds 28 bytes to the
complete graph from the module boundary. Player notices/deadlines and diagnostics were already lazy. Route,
configuration-generation, request-authority and cancellation fences must be available before their requests and
cannot safely move behind a lazy boundary. Translation catalogs remain independently lazy and under their unchanged
51,200-byte ceiling; the final build measures 44,582 bytes. The narrowly raised startup and complete-graph caps
retain 154 and 238 bytes respectively.

One pre-existing route-I/O limitation remains tracked on #1052: `fetch('/routes')` has no owned request deadline, so
a fetch that never settles can prevent the finite retry/fallback schedule from beginning. The current fix covers
settled network/non-2xx/schema/parse failures and authoritative emptiness; it does not describe route I/O itself as
time-bounded.

Exact current-candidate local qualification passed: 75 focused route/receipt/cancellation tests; the production
Coming-up journey with three refused `/routes` requests; all four WebKit retained-input cases; the full 3,153-test
Vitest suite with 16 skips; lint including zero Svelte diagnostics and strict Cast TypeScript; production Worker,
SSR shell and precompression verification; and the browser/TV isolation budgets above. These are source, local
browser and engine checks, not TV hardware qualification.

## Corrected contracts

- `SessionServices.configure` now reads guest plugin authority synchronously so its production Svelte effect observes
  A→B and A→B→A changes. It stops and withdraws the old discovery generation before awaiting replacement grant
  refresh; refresh and every Scout/Atlas/Reel/Remux/debrid completion remain independently fenced. Transport/5xx
  refresh results are explicit `retained-unverified` outcomes, cached guest services fail closed, and unchanged
  grant and route-discovery inputs retry on bounded cancelable schedules.
- Reconfiguration no longer implies revocation: automatic private-remux persistence and additive plugin changes stop
  and fence stale probes while keeping still-authorized services published, so Library does not unmount an active
  Player. Plugin contraction/replacement still withdraws synchronously, including A→B→A, and stale callbacks and
  Atlas acknowledgements remain fenced.
- Managed playback awaits household receipt-key establishment at the Player intent boundary. Browsing and an empty
  receipt lane still do not enter assistant crypto. Receipt acknowledgement rechecks abort/session authority after
  apply, while drain/apply/ack use the same household-scoped membership capability captured by that originating run
  in split, non-split, SharedWorker and legacy topologies.
- Cast readiness is a post-`load`, per-document challenge/echo handshake on both sides of the boundary. Origin and
  `Window` checks remain exact; a replacement Cast document rejects media and control until its own challenge and
  receives the latest session/subtitle/control state afterward. No CSP allowance was widened.
- `startSession` production 428 behavior retains the exact membership claim and body identity, adding only the
  requested IPv4 hint. Exact unheld-gid refusal and the 100-message/2,539-character receipt bounds remain unchanged.
- A page request blocked by the shared hello barrier now records whether grant selection was actually evaluated.
  Member→guest, guest→member, guest→guest and member→member replacements preserve the originating body/credential
  pair, including the guest secret for the already-started request; evaluated member/null can no longer fall through
  to a replacement guest. `RelaySession` remains synchronously isolated per SharedWorker port and has no such wait.
- Round 5 closes the remaining implicit-gid branch: `/remux/health` and OAuth approval now select and retain an
  already-held guest id and secret at request creation, just as they retain an existing member claim. A request that
  truly starts with neither proof still waits for the hello and takes its first resolved guest or member authority.
  Split-household member approval continues through its separately captured household membership capability; guest
  fallback and legacy topology use the corrected page relay path.

## Qualification

- Full Vitest: 231 files passed, 3 skipped; 3,080 tests passed, 16 skipped. This includes the joined real
  movie/episode receipt contract.
- Focused round-5 production-module coverage: 2 Vitest files and 49 tests passed. It covers both implicit-gid routes,
  all guest/member replacement directions, authority-less bootstrap to guest/member, exact OAuth body preservation,
  and split-household fixed-membership approval. Eleven serial Chromium cases passed across split-household assistant
  approval/settings, release-picker/remux switching and the production-shaped Svelte service-authority fixture; its
  marked active-player DOM node survives automatic remux persistence and an unrelated plugin addition.
- Edge receipt callback suite: 8 passed (748 unrelated tests filtered).
- Joined receipt production contract: the real Library Service created a drop-box without assistant consent; actual
  Edge callbacks queued one movie and one episode receipt; the service's real assistant authority applied both; and
  both progress records read back after reopening the durable library.
- Focused follow-up Vitest: 3 files and 83 tests passed across `LibraryLogAuthority`, the embedded assistant
  authority, and `LibraryServiceCore`. The Edge receipt module passed all 8 ordinary tests; its ignored bridge is
  invoked and required by the joined Vitest contract.
- Playwright: all 13 Cast-offer scenarios, two real built-Cast-page scenarios, and the real Svelte A→B→A authority
  test passed. Coverage includes receipt-intent ordering, visible handshake timeout/retry, reload/stale messages,
  document-local receive fencing, delayed Cast subresources and replay of state changed before load. This is
  Chromium fixture coverage, not Cast hardware qualification.
- `npm run lint` passed Prettier, ESLint, Stylelint, Svelte diagnostics, and strict Cast TypeScript.
- `npm run build` passed client/Worker verification, SSR shell, and precompression round-trip checks.
- LG/webOS, current Samsung/Tizen and explicit Tizen 3 builds passed Worker, compatibility and fixture-isolation
  verification. Tizen 3's JavaScript policy matched Wasm for 166 viewer fixtures and refused 12 intentionally absent
  admin/delivery fixtures; its CSS audit reported no unpaired unsupported `:is`. No TV/device execution occurred.
- Historical round-5 evidence: the standalone browser-to-TV isolation budget check was red on that exact clean base.
  Its old
  `c7e20146` baseline reports +2,792 initial gzip bytes there (+2,798 here). The six-byte difference is within the
  lazily shared relay chunk/build graph, while this fix introduces no new import or eager work; no budget pass is
  claimed for that historical head. The current-main matched result and passing narrowed budgets are recorded in
  **Current-main integration follow-up** above.
- No deployment, live homelab, stream probe, device run, TV packaging, or GitHub mutation was performed.

## Matched build evidence

The round-3 production build transformed the same 564 client and 144 SSR modules, passed Worker verification and
precompression round trips, and produced 4,531,484/1,650,238/1,366,612 raw/gzip/brotli bytes. Against the previously
recorded clean original-base build that is +1,918/+527/+437 bytes; against the round-2 snapshot it is
+818/+260/+152 bytes. The current client and SSR samples took 1.91 s and 0.189 s respectively; these single local
samples establish no performance gain or regression.

The round-4 production build transformed the same 564 client modules and emitted
4,531,731/1,650,332/1,366,627 raw/gzip/brotli bytes, +247/+94/+15 bytes from the recorded round-3 build. Preventing a
doomed Player teardown/recreation is a concrete mechanism-level improvement, but no runtime/device measurement was
taken, so no latency, frame, memory or energy saving is claimed. Capturing one grant secret for only the lifetime of
an already-started hello-blocked request is bounded and adds no network work.

The round-5 production build transformed the same 564 client and 144 SSR modules and emitted
4,531,716/1,650,399/1,366,470 raw/gzip/brotli bytes, -15/+67/-157 bytes from round 4. The fix performs the same
grant-map lookup at request creation that the non-waiting path already performs and retains one existing secret only
for the lifetime of a blocked request; it adds no request, retry, timer, render or background work. These static build
figures establish no runtime gain or regression.

Wasm SHA-256 is identical in both builds:

- assistant: `209dbe6e4f9e9c9b6fd9072d41b58ab9c01e57628813b4725497fea285ece5bc`
- deferred: `0ca965d2b4a64628951b8a23db1b7b2cac41426907d279e1e347e65211da89bd`
- recovery: `9ce86ca99a1853e391e9e1f271c69c9e09b54a83d43f3658d02043d7c78198dd`
- startup: `ae086beee41d6474f2a60abeb8677974df72af3075f5fbbfd195a58a28184a9e`

The whole-change binary patch from `d75e209815621f4f634ec7ca72df56736ec67e40`, excluding this self-referential
report file, has SHA-256 `a55103dbb39acaf4f814e742a537525df8e80e16dc38058ef4ec7b69354bf75c`. The
cumulative binary patch from the original named base, with the same exclusion, has SHA-256
`cae5b7364677d2b6df7ff25b1ef116a991d80ac12a06da121aa96623a3f12c4f`.

## Platform disposition and remaining work

- Browser: changed and source/unit/browser verified.
- LG/webOS and supported Samsung/Tizen: shared production paths changed; source/static/unit verified, no device run.
- Chromecast: sender and Cast document changed; Chromium contract verified, no receiver hardware run.
- iOS/iPadOS/tvOS: the existing native `PlaybackReceiptDrainer`, `AssistantClient` drain/ack/drop-box calls,
  `PairedLibrarySession` polling, split-household row binding and durable replay rows are the native receipt
  consumers. This Edge round did not modify or device-qualify them; remaining qualification is tracked by
  [oxyc/den#719](https://github.com/oxyc/den/issues/719). Den #717 is diagnostics, not receipt ownership.
- Tizen 3: reverified on the current candidate: grant/relay and route-recovery changes apply, but receipt crypto is
  explicitly unsupported. Ordinary in-page progress remains; post-page managed completion still has no specific
  recovery/handoff UI. Unsupported/recovery parity is tracked by
  [oxyc/den-edge#1059](https://github.com/oxyc/den-edge/issues/1059). The round-4 service-lifecycle and remux pairing
  fixes are in its shared legacy build; its additional explicit HLS exclusion selects progressive media instead.
- Android TV: not represented by this Edge web-runtime change; no Android receipt consumer was qualified here.

No new measured performance regression was found. Tizen 3's explicit crypto/recovery exclusion remains a
cross-platform gap; existing Apple native consumers are not misreported as absent.

The round-4 and round-5 changes are web-host lifecycle/transport fixes. iOS/iPadOS/tvOS have no `SessionServices` or page
`relayFetch` counterpart to change; their previously recorded receipt consumers were not rerun. Android TV remains
outside this Edge web runtime. No new defect, parity gap or follow-up issue was discovered beyond #1059 and the
already recorded Apple qualification work.
