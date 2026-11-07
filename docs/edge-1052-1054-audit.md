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
- Native Apple receipt parity is separately owned by Den #717 and is not changed here.

## Platform and performance disposition

- Browser, LG/webOS, Samsung/Tizen, and current Tizen use the shared authority, relay, and receipt paths. Chromecast is
  browser-only. Tizen 3 uses the shared authority/relay fixes and the empty-lane lazy guard; assistant receipt crypto
  remains explicitly unsupported by its `assistantCore-tizen3` adapter, so queued receipt work is left unacknowledged
  for a capable client rather than invented as successful.
- The authority refresh adds one already-required held-grant refresh before first discovery and removes doomed
  release/session work. The empty receipt lane performs one bounded drain request but no assistant policy import.
- A matched `npx vite build` from clean `HEAD` and this worktree transformed the same 564 modules (1.31 s versus
  1.30 s). Changed production chunks total +1,969 raw bytes and +538 gzip bytes: app +644/+196, Player +582/+204,
  lazy assistant +326/+112, Library Worker +427/+32, and relay −10/−6. All Wasm artifacts are byte-identical.
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
