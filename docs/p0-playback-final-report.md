# P0 playback final qualification

Base: `73d4166d8d1b3aa426793ee65ae849673ed65a3c`.
Joined-contract follow-up base: `d75e209815621f4f634ec7ca72df56736ec67e40`.
Round-3 blocker base: `2312314d19aaa7682795b7d894dcaffa46f4f244`.

## Corrected contracts

- `SessionServices.configure` now reads guest plugin authority synchronously so its production Svelte effect observes
  A→B and A→B→A changes. It stops and withdraws the old discovery generation before awaiting replacement grant
  refresh; refresh and every Scout/Atlas/Reel/Remux/debrid completion remain independently fenced. Transport/5xx
  refresh results are explicit `retained-unverified` outcomes, cached guest services fail closed, and unchanged
  grant and route-discovery inputs retry on bounded cancelable schedules.
- Managed playback awaits household receipt-key establishment at the Player intent boundary. Browsing and an empty
  receipt lane still do not enter assistant crypto. Receipt acknowledgement rechecks abort/session authority after
  apply, while drain/apply/ack use the same household-scoped membership capability captured by that originating run
  in split, non-split, SharedWorker and legacy topologies.
- Cast readiness is a post-`load`, per-document challenge/echo handshake on both sides of the boundary. Origin and
  `Window` checks remain exact; a replacement Cast document rejects media and control until its own challenge and
  receives the latest session/subtitle/control state afterward. No CSP allowance was widened.
- `startSession` production 428 behavior retains the exact membership claim and body identity, adding only the
  requested IPv4 hint. Exact unheld-gid refusal and the 100-message/2,539-character receipt bounds remain unchanged.

## Qualification

- Full Vitest: 231 files passed, 3 skipped; 3,061 tests passed, 16 skipped. This includes the joined real
  movie/episode receipt contract.
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
- No deployment, live homelab, stream probe, device run, TV packaging, or GitHub mutation was performed.

## Matched build evidence

The round-3 production build transformed the same 564 client and 144 SSR modules, passed Worker verification and
precompression round trips, and produced 4,531,484/1,650,238/1,366,612 raw/gzip/brotli bytes. Against the previously
recorded clean original-base build that is +1,918/+527/+437 bytes; against the round-2 snapshot it is
+818/+260/+152 bytes. The current client and SSR samples took 1.91 s and 0.189 s respectively; these single local
samples establish no performance gain or regression.

Wasm SHA-256 is identical in both builds:

- assistant: `209dbe6e4f9e9c9b6fd9072d41b58ab9c01e57628813b4725497fea285ece5bc`
- deferred: `0ca965d2b4a64628951b8a23db1b7b2cac41426907d279e1e347e65211da89bd`
- recovery: `9ce86ca99a1853e391e9e1f271c69c9e09b54a83d43f3658d02043d7c78198dd`
- startup: `ae086beee41d6474f2a60abeb8677974df72af3075f5fbbfd195a58a28184a9e`

The whole-change binary patch from `d75e209815621f4f634ec7ca72df56736ec67e40`, excluding this self-referential
report file, has SHA-256 `5478ac9d95c2c661a603f083dd10dcad93c06b961ed750b04adc8ee7ee647ec0`. The
cumulative binary patch from the original named base, with the same exclusion, has SHA-256
`1d70f04d0a3c7df781f986632cec7e809ad1b7ab0275a7020fd4931009aefacf`.

## Platform disposition and remaining work

- Browser: changed and source/unit/browser verified.
- LG/webOS and supported Samsung/Tizen: shared production paths changed; source/static/unit verified, no device run.
- Chromecast: sender and Cast document changed; Chromium contract verified, no receiver hardware run.
- iOS/iPadOS/tvOS: the existing native `PlaybackReceiptDrainer`, `AssistantClient` drain/ack/drop-box calls,
  `PairedLibrarySession` polling, split-household row binding and durable replay rows are the native receipt
  consumers. This Edge round did not modify or device-qualify them; remaining qualification is tracked by
  [oxyc/den#719](https://github.com/oxyc/den/issues/719). Den #717 is diagnostics, not receipt ownership.
- Tizen 3: grant/relay changes apply, but receipt crypto is explicitly unsupported. Ordinary in-page progress remains;
  post-page managed completion has no specific recovery/handoff UI. Unsupported/recovery parity is tracked by
  [oxyc/den-edge#1059](https://github.com/oxyc/den-edge/issues/1059).
- Android TV: not represented by this Edge web-runtime change; no Android receipt consumer was qualified here.

No new measured performance regression was found. Tizen 3's explicit crypto/recovery exclusion remains a
cross-platform gap; existing Apple native consumers are not misreported as absent.
