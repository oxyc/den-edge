# Edge #1052–#1054 implementation audit

## Authority and remux (#1052)

- `SessionServices` waits for the held-grant refresh before reading or publishing retained discovery. A failed refresh
  is fail-closed for guest plugins and a later configuration retries it.
- An A→B authority change synchronously disconnects an incompatible published Scout and clears its debrid result.
  Every discovery callback and delayed debrid answer is fenced to its originating run, including A→B→A.
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
  Failure leaves the queue unacknowledged and a later pass retries it. Tests cross the client codec, Worker host,
  `LibraryServiceCore`, real assistant authority malformed handling, queue transport, cancellation, and retry paths.
- Den #717 is diagnostics work; it does not own native receipt parity. The read-only issue search found no focused
  native receipt issue. iOS/iPadOS/tvOS do not implement this encrypted completion-receipt transport in the code
  reviewed here, so native parity remains unverified and incomplete; the issue draft below must be filed by an owner
  allowed to post to GitHub.

## Platform and performance disposition

- Browser, LG/webOS, and supported Samsung/Tizen builds use the shared authority, relay, and receipt paths.
  Chromecast is browser-only. Tizen 3 uses the shared grant/relay fixes, but its explicit
  `assistantCore-tizen3` adapter cannot create or open receipt crypto. It can still save ordinary in-page progress;
  managed playback completion after the page is gone is unsupported, and the current UI has no specific handoff or
  recovery notice for that limitation. That is an open parity/recovery gap, not a successful queued-receipt path.
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

- Focused Vitest: 8 files, 164 tests passed across session authority, relay, client receipt draining, codec,
  `LibraryServiceCore`, Worker-host rejection, and real assistant authority. The focused Edge callback/drain/ack test
  also passed (1 test; 755 filtered out).
- Playwright: all 11 `cast-offer` cases passed serially, including the deterministic document-generation regression;
  the managed sidecar expiry/replan case also passed. These are Chromium fixtures, not Cast hardware qualification.
- `npm run lint` passed Prettier, ESLint, Stylelint, Svelte diagnostics (0 errors and 0 warnings), and strict Cast
  TypeScript. `npm run build` passed the client/Worker verification, SSR shell build, and round-trip precompression;
  the reviewed client build transformed 564 modules. `git diff --check` is part of snapshot finalization.
- No deployment, homelab/device access, active stream probe, TV packaging, or public posting was performed.
- Source and browser fixtures use synthetic ids and ciphertext only; no production route token or private evidence is
  present in the patch.

## Follow-up issue draft (not posted from this supervised run)

**Title:** Add native Apple playback receipts and explicit Tizen 3 completion recovery

**Expected:** iOS/iPadOS/tvOS establish the household receipt drop-box before managed playback and durably apply
movie/episode completion receipts with the same authority, cancellation, retry and privacy contract as Web. Tizen 3
must either implement that contract within its documented crypto limits or visibly hand off/recover completion work
without claiming success.

**Actual/source evidence:** the native clients are outside this repository and no reviewed native receipt consumer
was found; Den #717 covers diagnostics only. In this repository `assistantCore-tizen3` explicitly refuses assistant
crypto, while managed playback can continue after receipt preparation fails, leaving only ordinary in-page progress.

**Acceptance:** production-path movie and episode tests cover first playback in a no-consent household, callback,
queue, real authority apply, durable readback, replacement/abort before ack, offline retry, and an explicit Tizen 3
unsupported/recovery presentation. Record iOS/iPadOS/tvOS/Tizen 3 performance and launch-cost results.
