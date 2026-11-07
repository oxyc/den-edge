# Edge #1052–#1054 implementation audit

## Authority and remux (#1052)

- `SessionServices` waits for the held-grant refresh before reading or publishing retained discovery. A failed refresh
  is fail-closed for guest plugins and bounded cancelable retry handles unchanged grant and route inputs.
- An A→B authority change synchronously disconnects an incompatible published Scout and clears its debrid result.
  It also stops and withdraws Atlas, Reel and Remux before replacement refresh; every route/discovery callback and
  delayed debrid answer is fenced to its originating run, including A→B→A while the replaced refresh is held.
- Discovery-input changes that do not contract authority are now separate from replacement. Persisting a private
  remux hint or adding an unrelated plugin cancels and fences prior probes while keeping its still-authorized
  Scout/Atlas/Reel/Remux publications until replacements answer. A production-shaped Svelte fixture proves the
  active Player DOM node survives both transitions; contraction still withdraws synchronously.
- Both page and SharedWorker relay fetchers treat a gid explicitly named by a remux body as authoritative. If that gid
  is not held, the request is refused locally; it is never signed with another held grant.
- Page relay requests held behind a library hello distinguish evaluated no-grant from unresolved initial authority.
  Member→guest, guest→member, guest→guest and member→member replacements preserve the exact request body plus
  originating member claim or guest secret; no replacement identity can sign the old body. SharedWorker
  `RelaySession` has no hello barrier and already selects body and credential synchronously per port.
- The final implicit-gid audit covers both `/remux/health` and `/oauth/request/:id/approve`: an already-held guest
  proof is selected with its secret before the hello wait, while a request created with no member or guest authority
  remains unresolved and takes the first authority installed by the hello. OAuth approval keeps its exact body with
  that proof. Split-household member approval uses its captured household fetch capability; its guest fallback and
  legacy topology share the corrected page relay.
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
- This follow-up built browser, LG/webOS, current Samsung/Tizen and the explicit Tizen 3 legacy target. The two new
  fixes are in shared page/session modules on all four web targets. Tizen 3's existing exclusions remain assistant
  and recovery crypto plus HLS (progressive playback is selected); they do not exclude service authority or remux
  pairing. Its JavaScript policy matched Wasm for 166 viewer fixtures and refused 12 deliberately absent
  admin/delivery fixtures. No TV hardware was run.
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

- Follow-up focused Vitest: 2 files and 44 tests passed across session authority and actual relay transport. Full
  Vitest passed 3,080 tests with 16 skipped, including the joined production receipt contract; earlier
  codec, `LibraryServiceCore`, Worker-host, assistant-authority and Edge callback suites remain in that bundle.
- Round-5 focused production-module Vitest passed 49 tests across relay and OAuth. The added matrix covers both
  implicit routes, all four guest/member replacement directions, authority-less bootstrap to either proof, and the
  split-household fixed-membership approval path.
- Follow-up Playwright: 11 managed-playback, release-picker/remux and real Svelte authority cases passed serially,
  including both real split-household assistant cases and the automatic remux-persistence/player-identity case.
  These are Chromium fixtures, not device qualification; previously recorded Cast cases were not rerun in this
  follow-up.
- `npm run lint` passed Prettier, ESLint, Stylelint, Svelte diagnostics (0 errors and 0 warnings), and strict Cast
  TypeScript. `npm run build` passed the client/Worker verification, SSR shell build, and round-trip precompression;
  the reviewed client build transformed 564 modules. LG/webOS, current Tizen and explicit Tizen 3 builds passed their
  Worker/compatibility/isolation verifiers; the Tizen 3 emitted-CSS report found no unpaired unsupported `:is` rule.
  `git diff --check` is part of snapshot finalization.
- No deployment, homelab/device access, active stream probe, TV packaging, or public posting was performed.
- Source and browser fixtures use synthetic ids and ciphertext only; no production route token or private evidence is
  present in the patch.
- Browser, webOS, current Tizen and explicit Tizen 3 builds passed; the Tizen 3 packaged-mode CSS audit found zero
  unsupported `:is` rules. The separate TV-isolation budget check also fails on an archive of the exact round-5 base
  against its older `c7e20146` baseline (+2,792 initial gzip bytes; +2,798 after this patch), so the unrelated baseline
  was not changed and this check is not reported as passing.
- Privacy improves: an old request can no longer expose its body under a replacement member or guest identity. The
  captured guest secret lives only for that already-started request's hello wait and still leaves only in the existing
  same-origin header. Round-5 production output is 4,531,716/1,650,399/1,366,470 raw/gzip/brotli bytes,
  -15/+67/-157 against round 4. The only added hot-path work is the grant lookup the non-waiting path already made;
  there is no extra network, timer, retry or render work, and no runtime or device performance gain is claimed.
