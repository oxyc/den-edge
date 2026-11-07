# Edge #1052–#1054 implementation audit

## Authority and remux (#1052)

- `SessionServices` waits for the held-grant refresh before reading or publishing retained discovery. A failed refresh
  is fail-closed for guest plugins and bounded cancelable retry handles unchanged grant and route inputs.
- An A→B authority change synchronously disconnects an incompatible published Scout and clears its debrid result.
  It also stops and withdraws Atlas, Reel and Remux before replacement refresh; every route/discovery callback and
  delayed debrid answer is fenced to its originating run, including A→B→A while the replaced refresh is held.
- Both page and SharedWorker relay fetchers treat a gid explicitly named by a remux body as authoritative. If that gid
  is not held, the request is refused locally; it is never signed with another held grant.
- Tests cover delayed and failed grant refresh, stopped-profile refresh completion, retained A against B, A→B→A,
  stopped discovery callbacks, movie and episode release bodies, releases/session gid equality, and the 428 retry.

## Cast document authority (#1053)

- Cast readiness now belongs to an iframe document generation, not merely an origin. Initial `about:blank`, source
  replacement, and same-origin reload invalidate the generation; an exact `event.source` and `event.origin`
  `den-ready` is required before media or control messages cross the boundary.
- Media load, subtitle choice, seek, continue, and receiver-choice sends are gated. The next `den-load` carries the
  current subtitle and position after subtitle preparation or a document reload.
- Browser coverage withholds readiness, proves no early `den-load`, rejects a wrong-source message, reloads the same
  frame, and proves only the current document receives the load. Existing focused cases cover managed failure/refresh,
  signed-LAN handoff, timeout/no receiver, and session replacement.
- The production-only `prepare.js` CSP/artifact mismatch is separate and remains open as #1056. This change does not
  weaken CSP or add inline-script allowances.

## Playback receipts (#1054)

- The task codec now carries ensure/apply requests and results with Edge's exact limits: 100 messages and 2,539
  ciphertext characters. Null, exact-bound, overflow, extra-field, and malformed-result cases are covered.
- Ensure creates and publishes a household receipt drop-box even when the household has no assistant grant; it does
  not create an assistant grant. The foreground path drains the opaque lane first, so an empty lane never initializes
  assistant crypto/Wasm.
- Key publication, connection lending, and apply are fenced after every await to the current foreground profile.
  Drain/apply/ack also retain one originating membership capability in split, non-split, SharedWorker and legacy
  topologies; a replacement library completing the relay-opening barrier cannot lend its claim to an old request.
  Failure leaves the queue unacknowledged and a later pass retries it. Tests cross the client codec, Worker host,
  `LibraryServiceCore`, real assistant authority malformed handling, actual `assistant.ts` plus `relayFetch`,
  cancellation, and retry paths.
- A joined production-contract test starts with the real Library Service in a no-consent household, creates its
  drop-box, passes movie and episode ciphertext through the actual Edge callback and drain, applies both through the
  service's real assistant authority, and reopens the durable library for readback. Apple platforms already have
  `PlaybackReceiptDrainer`, `AssistantClient` receipt transport, `PairedLibrarySession` polling, split-household row
  binding and durable replay rows; [oxyc/den#719](https://github.com/oxyc/den/issues/719) tracks remaining native
  qualification rather than implementation of an absent consumer. Den #717 remains diagnostics only.

## Platform and performance disposition

- Browser, LG/webOS, and supported Samsung/Tizen builds use the shared authority, relay, and receipt paths.
  Chromecast uses the shared sender plus its fenced Cast document. Apple native consumers already exist but were not
  changed or device-qualified by this Edge round. Tizen 3 uses the shared grant/relay fixes, but its explicit
  `assistantCore-tizen3` adapter cannot create or open receipt crypto. It can still save ordinary in-page progress;
  managed playback completion after the page is gone is unsupported, and the current UI has no specific handoff or
  recovery notice for that limitation. That open parity/recovery gap is tracked by
  [oxyc/den-edge#1059](https://github.com/oxyc/den-edge/issues/1059), not represented as a successful queued-receipt
  path.
- The authority refresh adds one already-required held-grant refresh before first discovery and removes doomed
  release/session work. The empty receipt lane performs one bounded drain request but no assistant policy import.
- Matched clean-archive and worktree production builds transformed the same 564 client modules. The complete build
  took 12.02 s at `73d4166d` and 11.47 s here (client 2.92 s and 2.77 s); this local single-run difference is noise,
  not a claimed speedup. The four directly changed chunks total +1,100 raw/+295 gzip bytes: app +866/+202, Player
  +111/+40, lazy assistant +69/+29, and grants +54/+24. The four Wasm artifacts are byte-identical by SHA-256.
- Five fresh-Chromium foreground measurements against the same dev server put an empty receipt drain at a 5.7 ms
  median and verified that it requested no assistant crypto. The formerly eager cold crypto path had a 10.4 ms
  median of its own and transferred 539,369 dev bytes, including the 491,145-byte assistant Wasm. These are local
  matched measurements, not device or production-network savings.

## Validation boundaries

- Round-3 focused Vitest: 3 files and 50 tests passed across session authority, actual relay transport and receipt
  draining. Full Vitest passed 3,061 tests with 16 skipped, including the joined production receipt contract; earlier
  codec, `LibraryServiceCore`, Worker-host, assistant-authority and Edge callback suites remain in that bundle.
- Playwright: all 13 `cast-offer` cases, two real built-Cast-page cases and the real Svelte authority case passed
  serially. These are Chromium fixtures, not Cast hardware qualification.
- `npm run lint` passed Prettier, ESLint, Stylelint, Svelte diagnostics (0 errors and 0 warnings), and strict Cast
  TypeScript. `npm run build` passed the client/Worker verification, SSR shell build, and round-trip precompression;
  the reviewed client build transformed 564 modules. `git diff --check` is part of snapshot finalization.
- No deployment, homelab/device access, active stream probe, TV packaging, or public posting was performed.
- Source and browser fixtures use synthetic ids and ciphertext only; no production route token or private evidence is
  present in the patch.
