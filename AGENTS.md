# Working in den-edge

## Contributor development

- `./scripts/dev.mjs` is the default contributor entry point. It runs the local Vite UI against the live public
  `d.oxy.fi` stack; an invited guest can use centralized Hearth, their own TorBox configuration, and authorized
  Remux without LAN access. This mode uses live guest data/resources and must never back fixtures or automation.
- Guest state is origin-local. Redeem/paste the invite on the localhost UI, or replace an existing guest session's
  “Use Den on your phone” link origin with `http://localhost:5173/` while preserving its fragment; merely opening
  the production invite signs in `d.oxy.fi`.
- `./scripts/dev.mjs --local-edge` is for Rust/backend changes and needs no invite: a loopback-only Edge with
  persistent isolated state in `.dev/data`, and no authority over centralized Hearth. `--hearth` adds a local Hearth
  container wired to it (relay, playback, shared secret, origins), with secrets kept in `.dev/hearth.env`. The
  launcher runs `NEW_LIBRARIES=open` until the first library exists, then restarts Edge as `members`, which guest
  invites and the member Den configure flow need; an explicit `NEW_LIBRARIES` is kept. Never restore private `192.168.*` defaults.
- Optional provider keys for local mode (`TMDB_KEY`, `OMDB_KEY`, `DOESTHEDOGDIE_KEY`, `SIMKL_CLIENT_ID`) live in the
  gitignored `.dev/env`, which the launcher reads on every run; `TMDB_KEY` also reaches Hearth's Reel unless
  `REEL_TMDB_KEY` is set. Never write a key into a tracked file, a log or a command line.
- macOS and Linux only; Windows is untested and unsupported (WSL).
- Every Playwright/E2E server must retain `DEN_E2E=1`; real-service overrides are forbidden there. A service proxy
  carries Edge membership, grant, token, cookie and authorization headers only to the Edge that issued them: strip
  them for a standalone addon, and for the public stack's relays whenever `DEN_EDGE` names another Edge.
- The centralized Cast sender deliberately trusts only the exact contributor origin `http://localhost:5173` in
  addition to production/deployment origins. Keep its Rust CSP and bundled `VITE_DEN_PARENT_ORIGINS` allowlists in
  sync; never widen this active controller to arbitrary localhost ports. An operator's own development origins come
  from the `DEN_PARENT_ORIGINS_EXTRA` repository variable at build time, never from this repo: it is public.

## What the trailers have to do

**The best picture the browser can play, as soon as possible, in every browser.** Both halves, not one traded for
the other, and no browser left as the lowest common denominator.

- **A visibly poor picture is worse than a short wait.** The still artwork is already underneath every trailer.
  Keeping it there a moment longer costs nothing; opening at 144p and climbing for four seconds is seen every time
  and looks broken.
- **Quality is chosen per browser.** Which player, which ladder and which codecs differ between WebKit, Chromium and
  whatever a phone offers. Serve each one what it plays best, not something all of them tolerate.
- **The ladder is the first lever, not the last.** A master that never offers a useless rung cannot open on one, in
  any browser and in any player — including the platform players we do not configure. den-reel filters and floors
  its master (`playable`, `native=1`); prefer fixing the ladder there over steering a player here.

## Find the cause before writing the fix

**A plausible explanation is not a diagnosis.** Every fix here lands on a box the user then has to test by hand, on
his own hardware, often after clearing a cache. A guess that ships spends his time, not yours — and if it is wrong
it leaves behind code built on a false premise. So, in order:

1. **Measure on the live page.** Chrome and Safari consoles are available, and the user will run a snippet on
   request. A console experiment costs seconds; a release costs a build, a deploy, a cache clear and his attention.
2. **Bisect against a control.** Change one variable at a time and compare with something known to work — stock
   library configuration beside ours, a bare element beside the styled one, one codec beside another. A hypothesis
   never tested against a control is still a hypothesis.
3. **Only then change code**, and say in the commit what was measured, on what, and what it showed.

Worked in practice: a billboard trailer stalling on Safari was blamed in turn on an audio rendition, `volume`, VP9,
and page compositing — four releases, three of them wrong. What found it was running a stock `new Hls()` next to ours
on the same page: ours crawled, stock played. The cause was our own forced `nextLevel`, and the fix deleted code
rather than adding it.

## Prefer deleting the cause to compensating for it

When a workaround and a removal both fix the symptom, remove. Compensating code outlives the browser bug it was
written for, and the next reader cannot tell which is which.

## Never write an unproven mechanism into a comment as fact

Comments here explain why, which makes them the place a wrong theory does the most damage — it reads as established
later. Write what was measured ("itag 616 stalled, currentTime frozen at 6.69s while the decoder ran at 25x"), not
what it is assumed to mean. If the cause is inferred rather than observed, say so in the comment.

## Releasing and deploying

- A merge to `main` deploys nothing. Release with `scripts/release.sh X.Y.Z`: it changes only `VERSION`, pushes that
  commit, and waits for its exact main CI before creating `vX.Y.Z`. Never tag or push a `v*` tag by hand. Do not bump
  Cargo.toml: the image supplies `DEN_VERSION` at runtime so a web-only release can reuse the Rust build.
- Main CI is the release gate and artifact producer: it tests, builds, probes, scans, and records immutable edge/cast
  candidate digests. A tag only verifies and promotes those digests; it must never rebuild a subtly different
  artifact. A failed main run creates no tag and cannot move `:latest`.
- Main CI skips its test jobs when a run in this repo already passed them on byte-identical source (the tree without
  `VERSION`, `scripts/ci-verdict.sh`), e.g. the PR run of an un-moved merge or a version commit's predecessor. It
  still builds, probes and scans the candidate for its own SHA.
- Production picks up a published release within about a day on its own. Deploying sooner or rolling back needs
  homelab shell access; without it, say the release is published and awaiting the daily deploy, not that it is live.
  The full path is in the README's "From merge to running".
- Release only when asked: a tag ships to every household's browser.

## Shared checkout

This checkout is shared with other agent sessions. Commit with an explicit pathspec, never `-a`, and check that
everything the committed code imports is committed too.

## Bundle budget records

- Exact-current Owner PIN replacement/removal (#1145) was measured on matched production builds at base
  `7fff9db5` and source `9509c5ab`. Ordinary Browser startup moves 206,062 → 206,132 gzip bytes (+70), while the
  complete graph moves 890,492 → 892,313 (+1,821). Independently lazy Spanish/Swedish catalogs account for +418,
  leaving the non-translation graph 840,831 → 842,234 (+1,403). WebOS startup moves 241,848 → 242,251 and its
  non-translation graph 940,936 → 942,769 (+1,833); supported Tizen moves 242,580 → 242,898 and 1,261,627 →
  1,263,272 (+1,645). Reduced Tizen 3 compiles the editor and its content-provider dependencies out while retaining
  the fixed supported-browser handoff: startup moves 193,377 → 193,381 (+4), the complete non-translation graph
  2,354,772 → 2,346,492 (-8,280 gzip), and the raw JS/CSS graph 8,349,411 → 8,323,703 (-25,708 bytes).
  The PIN form remains in the existing lazy Settings chunk and the ES/SV copy remains independently catalog-lazy.
  The protocol-version gate, exact-row compare-and-swap, current-PIN authentication, serialized profile-topology
  guard and durable replay prevention must stay with the shared Worker that owns the row; another split would add an
  authority request or duplicate the admission state before Settings can recover. The change adds no dependency,
  polling, timer, cache, background task, provider call or healthy-path extra network round trip. One explicit
  submit remains one library command and, on success, one settings-row write. The startup ceiling advances from
  9,728 to 9,856, the smallest 128-byte boundary containing the 9,736-byte matched graph (120-byte margin); the
  complete non-translation ceiling advances from 115,072 to 116,480, containing 116,444 with 36 bytes of margin.
  The separate translation ceiling remains 51,200 with 1,121 bytes of margin.
- Truthful assistant recovery and the reduced-Tizen Web handoff (#1278/#1204) were measured on matched production
  builds at base `92e5aae9` and head `1082574e`. Ordinary browser startup moves 206,041 → 206,062 gzip bytes
  (+21), while the complete graph moves 888,421 → 890,492 and its independently lazy Spanish/Swedish catalogs
  move 49,007 → 49,661, leaving the non-translation graph 839,414 → 840,831 (+1,417). The existing lazy
  Connect dialog accounts for about 0.73 KiB and the existing lazy Settings surface for about 0.53 KiB; the
  remaining non-translation delta is the shared Worker's acknowledged-row readback/protocol and minification.
  WebOS startup moves 241,789 → 241,848 and its non-translation graph 939,310 → 940,936 (+1,626); supported
  Tizen startup moves 242,493 → 242,580 and its non-translation graph 1,259,953 → 1,261,627 (+1,674). Reduced
  Tizen 3 instead removes the connector, assistant queue and projection-Worker chunks: startup moves 193,447 →
  193,377, the complete non-translation graph 2,371,801 → 2,354,772 (-17,029 gzip), and the raw JS/CSS graph
  8,391,911 → 8,349,411 (-42,500 bytes), while retaining only a focusable handoff in its existing lazy Settings
  chunk. Recovery adds no dependency, standing/background polling, healthy-path request or background work; the
  post-link consent race uses one bounded local 100 ms authority wait, for at most 10 seconds. Additional list
  retries and rollback readbacks run only after failure or explicit Retry. Consent lifetime and cleanup must remain in
  the already lazy Connect dialog, presentation/focus in lazy Settings, and durable acknowledged-row proof in the
  shared Worker that owns those rows. Splitting any again would add a request on the sole recovery path or duplicate
  authority; locale copy is already independently lazy. The Tizen 3 Worker-constructor split is the only safe
  additional boundary and removes rather than moves that runtime from the reduced package. The fixed startup and
  translation ceilings remain unchanged, with 62 and 1,539 bytes of margin. The complete non-translation ceiling
  advances from 113,664 to 115,072 over the fixed baseline, the smallest 128-byte boundary containing the matched
  115,041-byte graph, retaining 31 bytes.
- Optional title-facts recovery (#1270) was measured on matched production builds at base `a819734f` and the
  final repair: ordinary browser startup moves 203,991 → 203,986 gzip bytes (-5), while the complete graph moves
  878,272 → 879,947 (+1,675). Independently lazy Spanish/Swedish catalogs account for +68, so the complete
  non-translation budget graph moves 105,161 → 106,768 (+1,607). The existing lazy Detail JS/CSS accounts for
  +834 and the existing content-service Worker for +807; unrelated minification changes offset the remainder.
  Recovery owns partial-lane presentation, focus restoration and exact-title/region/locale/profile cancellation in
  Detail, while producer validation, selective provider calls and the bounded wire contract must remain in the
  Worker. Both are already lazy boundaries; splitting either again would add a request during detail failure or
  Worker startup without removing the complete graph, and EN/ES/SV copy is already catalog-lazy. No dependency,
  polling, timer, persisted state or healthy-path provider request is added. Allow the smallest 128-byte boundary,
  106,880, preserving 112 bytes of margin after the previous budget's 55-byte reserve.
- The truthful Apple TV diagnostics handoff for Den #538 was measured on matched production builds at base
  `9783e49c` and the final repair: ordinary browser startup moved 204,013 → 203,991 gzip bytes (-22), while the
  complete graph moved 878,206 → 878,272 (+66). Independently lazy Spanish/Swedish catalogs account for +51, so
  the complete non-translation graph moves 105,146 → 105,161 (+15) and remains below the existing 105,216 ceiling
  with 55 bytes of margin. The copy was consolidated to one short sentence after a first draft crossed the budget;
  no correctness text can be removed without again implying an upload/share route or correlated support id that
  does not exist. It stays in the existing lazy Settings chunk and existing lazy locale catalogs. Another dynamic
  import would add a request to render one paragraph and cannot reduce the complete graph. No budget changes are
  required, and no request, timer, listener, storage, dependency or startup work is added.
- Canonical provider-variant routing (#1271) was measured on matched production builds at base `320867eb` and the
  final repair: ordinary browser startup moved 203,925 → 204,013 gzip bytes (+88), while the complete graph moved
  877,726 → 878,206 (+480); translation catalogs are unchanged at 47,270, so the complete non-translation graph
  moves 104,666 → 105,146. The existing lazy Detail chunk accounts for +164 bytes, its existing services chunks for
  +155 net, the lazy Settings navigation for +39, and the eager Library/app shell for +80, with minification changes
  elsewhere accounting for the remainder. Browser Detail, Home and hover priming reuse the profile-owned,
  region-and-language-keyed service-directory cache to collapse raw provider variants onto one canonical route;
  it adds no per-badge request, polling, timer, listener, dependency, persisted state or private diagnostic. A
  directory miss/failure leaves the truthful raw badge non-routable and retains the existing external JustWatch
  handoff. LG/webOS and supported Samsung/Tizen compile the same noninteractive badge presentation and do not ask
  the directory. The normalization and request must stay in the existing lazy Detail/services boundary: moving
  them eager would spend more startup bytes, while another dynamic import would add a request before the badge can
  become usable and cannot reduce the complete graph. Home's small eager locale-generation fence must remain beside
  the existing top-level provider-row readiness state: moving it into lazy HomeCatalogue would duplicate or delay
  the same directory authority needed by radar rows and their captions. No correctness branch can be removed
  without restoring an invented variant route, stale-language publication, duplicate request or duplicate badge.
  The complete-graph ceiling therefore advances from 104,704 to 105,216, the smallest 128-byte boundary that
  contains the matched build, retaining 70 bytes; the independent startup and translation ceilings remain
  unchanged.
- Native guest-administration handoff (#536) was measured on matched production builds at base `5f7d4ac6` and the
  repair. The ordinary browser startup graph moved 203,915 → 203,925 gzip bytes (+10), while its complete graph
  moved 877,552 → 877,726 (+174); independently lazy translation catalogs account for +211, so the complete
  non-translation graph shrinks 104,703 → 104,666 and remains under the existing 104,704 ceiling. On reduced
  Tizen 3, the complete JS graph moves 2,413,572 → 2,413,984 (+412): the already lazy Settings chunk accounts for
  +223, the Spanish/Swedish catalogs for +206, and the two startup chunks together move 233,442 → 233,443 (+1).
  The focusable handoff is compiled only for the deliberately reduced Tizen target; ordinary Browser, LG/webOS,
  and supported Samsung/Tizen retain their existing full guest-administration surface. It adds no dependency,
  request, timer, listener, persisted state or secret. The row belongs in the existing lazy Settings surface, and
  splitting its three short strings or one focusable row behind another dynamic import would add a request at the
  recovery handoff without reducing the complete graph. No budget changes are required.
- Kid direct-read authority (#1221) was measured on the current-main merge build before and after consolidating its
  internal admission result from three repeated strings to `boolean | null`: startup moved 203,815 → 203,804 gzip
  bytes (baseline delta 7,419 → 7,408) and the complete non-translation graph moved 101,388 → 101,377 bytes.
  Extracting the repeated refused/unavailable wire mapping grew the complete graph by 33 bytes, and reversing its
  sentinel ternary grew it by 53, so both were removed. `ContentAuthority` already lives in the separately built
  shared Worker; the isolation gate totals every JS/CSS chunk, so moving Atlas admission behind a new dynamic import
  cannot reduce the complete graph and would add a request before a P0 authorization decision. Moving it into an
  existing page lazy chunk is unsafe because Browser, LG/webOS, Samsung/Tizen and reduced-Tizen all ask the Worker,
  while compiling it out for a target would remove the same Kid veto. The ceiling therefore advances to the next
  128-byte boundary, 101,504, retaining 127 bytes on the matched build; the independent startup ceiling is unchanged
  and retains 15 bytes. The production hydration fix then deleted the profile layer's conversion of an authority
  failure into an empty eligibility answer, letting the existing bounded library-naming retry own it. On the same
  build it adds 6 startup and 25 complete-graph bytes (203,810 and 101,402), retaining 9 and 102 respectively without
  another budget change. Preserving that typed failure through the lazy Detail screen and adding its translated,
  accessible recovery presentation then moves startup to 203,809 and the complete non-translation graph to 101,495,
  retaining 6 and 9 respectively; the separately excluded translation chunks move 46,350 → 46,397 gzip bytes.
  After merging current main's Remux link learning and 60-second start hold, the matched combined production build
  measures startup at 203,797 (baseline delta 7,401, 18-byte margin) and the complete non-translation graph at
  101,667. Compared with the pre-merge Kid head, startup shrinks by 12 bytes and the complete graph grows by 172;
  translations remain 46,397. The admission-sentinel consolidation and rejected wire-mapping/ternary experiments
  above remain the smallest safe implementation, while the isolation gate's complete-graph accounting means moving
  either the Worker admission or the existing Remux/playback code across a lazy boundary cannot reduce this total
  and would add an authorization- or playback-critical request. The ceiling therefore advances one 128-byte step
  from current main's 101,632 to 101,760, retaining 93 bytes on the combined build. Bounding the shared binge
  console records then moves the matched production build's startup 203,797 → 203,812 gzip bytes and complete
  non-translation graph 101,667 → 101,700, retaining 7 and 60 bytes respectively without another budget change;
  the existing lazy Player JS/CSS pair itself shrinks by 16 bytes. The helper remains in the Player-only binge
  module and adds no import, request, timer or listener; another lazy boundary would add a request without reducing
  the complete graph.
- Watchlist desired-state Retry (#499) was measured on matched production builds at base `6e5bce2d` and the repair:
  startup moved 203,801 → 203,799 gzip bytes, while the complete non-translation graph moved 101,684 → 102,327
  bytes (+643). The existing lazy Watchlist JS/CSS pair accounts for 642 bytes of the delta (4,952 → 5,594); the
  selected-language failure copy adds 23 gzip bytes across the independently lazy Spanish/Swedish catalogs, and the
  test fixture/E2E do not ship. The repair reuses the existing failure and `Try again` presentation, stores only the
  latest refused desired action while that exact card/session remains presented, restores focus after recovery, and
  adds no dependency, request, polling, timer or healthy-path work. Its UI and authority lifetime must stay beside
  the already lazy Watchlist surface: moving it eager would spend startup bytes, while another dynamic import would
  add a request at the moment recovery is needed and cannot reduce the complete graph. No production code or data
  was available to remove without losing the localized failure, stale-result, focus or retry contract. The ceiling
  therefore advances from 101,760 to 102,400, the next 128-byte boundary, retaining 73 bytes; the independent
  startup and translation ceilings remain unchanged.
- Household-sharing escrow recovery (#1146) was measured on matched production builds at base `e099edbd` and the
  repair: startup moved 203,801 → 203,870 gzip bytes (+69), while the complete graph moved 875,858 → 876,745
  and its independently accounted translation catalogs moved 46,557 → 46,684, leaving the non-translation graph
  829,301 → 830,061 (+760). The existing lazy Settings chunk accounts for +761 bytes and the already shared lazy
  grants module for +98; the initial app chunk shrinks by 7 and minification changes elsewhere offset the remainder.
  The repair adds no dependency, polling, timer or healthy-path request: its extra readback and retry occur only
  after an automatic escrow write fails. The authority lifetime, durable readback, visible recovery and localized
  notice must stay with the existing lazy Sharing settings, while the grants result contract is shared by that
  surface and its tests. Moving either behind another dynamic import would add a request on an already-failing
  recovery path and cannot reduce the complete-graph total; translation copy already uses the lazy locale catalogs.
  No production branch can be removed without losing a reviewed failure, refusal, stale-authority or retry outcome.
  The complete-graph ceiling therefore advances from 103,680 to 104,320, the next 128-byte boundary, retaining 49
  bytes on the matched build; the independent startup and translation ceilings remain unchanged.
- Subtitle-timing profile localization (#1167) was measured on matched production builds at base `c78408e9` and
  the rebased repair: startup moved 203,870 → 203,915 gzip bytes (+45), while the complete graph moved 876,745
  → 877,552 and its independently accounted translation catalogs moved 46,684 → 47,059, leaving the
  non-translation graph 830,061 → 830,493 (+432). The existing lazy Player chunk accounts for +202 bytes, the
  existing shared i18n runtime for +104, and the Spanish and Swedish lazy catalogs for +185 and +186 respectively;
  remaining minification changes account for the balance. The repair adds no dependency, request, polling,
  persistence, cue-tick, decoder or media-reload work. One formatter is retained only for the current profile
  language and replaced on language change; result expiry remains one bounded existing timer. Timing copy and
  locale-number formatting must be available synchronously inside the already lazy Player surface, while Spanish
  and Swedish copy already lives in their lazy catalogs. Another dynamic import would add a request while the HUD
  is open and cannot reduce the complete-graph total; moving the code eager would spend startup bytes. No reviewed
  localization, accessible-live-value, stale-language or falsey-result branch can be removed without losing the
  contract. The complete-graph ceiling therefore advances from 104,320 to 104,704, the smallest 128-byte boundary
  that contains the matched build, retaining 1 byte; the independent startup and translation ceilings remain
  unchanged.
- Owner-only Kid creation for Browser, LG/webOS and supported Samsung/Tizen (#940) was measured after rebasing on
  exact PR parent `c047e499`. Startup moves 203,986 → 206,114 gzip bytes (+2,128), the complete non-translation graph
  moves 832,558 → 836,991 (+4,433), and the independently lazy Spanish/Swedish catalogs move 47,389 → 48,022
  (+633). The new form is already a separate 2,059-byte gzip JS/CSS chunk fetched
  only after an active Owner chooses Add Kid; the reduced Tizen 3 build compiles that import out and contains no
  AddKidProfileForm chunk. The remaining growth is the eagerly mounted profile switcher's localized loading/failure
  handoff (+311 in the English i18n chunk), the exact Owner/session and durable create/resume/ack authority (+1,787
  across appMain JS/CSS), and the shared Worker task contract (+150). Those pieces must be
  present before the lazy form can be admitted and must agree across browser pages and packaged-TV Workers; moving
  them behind the form would make admission/reload recovery depend on a second authority implementation or expose
  private coordinator state, while another form split would add a request without reducing the complete graph.
  Test fixtures do not ship. No dependency, polling, background task or healthy-path request was added; one create
  task runs only after explicit Owner PIN submission, and one resume task runs only when Add Kid opens. The final
  25-byte startup and 48-byte complete-graph increments restore remote focus after Back/Cancel; that code must stay
  beside the eagerly mounted switcher because the lazy form is already gone when focus is repaired. The existing
  startup margin absorbs 182 bytes, so its ceiling advances to the next 128-byte boundary, 9,728 over baseline,
  retaining 10 bytes. The complete-graph margin absorbs 33 bytes and its ceiling advances to 111,232 over baseline,
  retaining 31. The fixed 51,200-byte translation ceiling remains unchanged with 3,178 bytes of margin.
- Compound profile-key reset for Browser, LG/webOS and supported Samsung/Tizen (#941) was measured on matched
  production builds at current-main `a6b5765a` and head `5a0fba4d`: startup moves 206,114 → 206,041 gzip bytes
  (-73), the complete non-translation graph moves 836,991 → 839,414 (+2,423), and the independently lazy
  Spanish/Swedish catalogs move 48,022 → 49,007 (+985). The reset coordinator is already a separate 1,121-byte
  gzip chunk fetched only when an Owner starts or resumes the destructive operation. The remaining growth is the
  existing lazy Settings surface's PIN/failure/recovery/focus presentation (+1,165 JS/CSS), exact link persistence
  and durable-marker handoff (+121), the shared Worker protocol/journal path (+90), and the browser-wide lock helper
  (+195), partly offset by 261 bytes of startup/assistant consolidation. Test fixtures do not ship. The reset adds
  no polling, timer, background task or healthy-path request; exact storage readback runs only during this explicit
  reset, and retries reuse one durable attempt. Moving Settings presentation behind another import would add a
  request while showing the only recovery action; moving link/marker authority or Worker protocol behind the page
  chunk would make startup recovery depend on UI code that is intentionally absent until needed. No further split
  can reduce the complete graph without duplicating authority or weakening reload recovery. Startup remains within
  its existing ceiling, and translations remain under their fixed 51,200-byte ceiling by 2,193 bytes. The complete
  graph ceiling advances from 111,232 to 113,664, the smallest 128-byte boundary containing the matched build,
  retaining 40 bytes.

## Testing

- Do not add a regression test mechanically for every change. Trivial styling changes, copy edits, and straightforward substitutions of an existing shared component usually need the relevant static checks, not a new test.
- When a regression test is warranted, prefer an end-to-end test of the user-visible behavior over a component or unit test. Cover the real route and interaction across the browser boundary when practical.
- Use unit tests for isolated logic with meaningful branches, invariants, or failure cases that end-to-end coverage would make slow, opaque, or impractical.
- Keep tests proportional to the risk. Do not assert implementation details merely to prove that a small refactor happened.

## Standing rule: parity, performance and discoveries

- These rules apply to every Den addition, fix, removal and behavior-affecting refactor, not only the audit backlog. Default to behavioral and contract parity across iOS/iPadOS, tvOS, browser, LG/webOS and Samsung/Tizen, plus relevant shared services/consumers in the active `den` and `den-*` repositories. Platform-appropriate UI can differ; authority, data semantics, capabilities, notices, recovery and supported outcomes must agree.
- Inspect the equivalent production paths on every target using current code and relevant PRs/issues. Do not assume a shared helper means each host uses it correctly, or that another platform is the reference implementation. Implement the corresponding change everywhere applicable; a correct counterpart may only need verification. For removals, retire matching affordances/routes/capabilities and handle persisted state, caches and older-client compatibility.
- Honor explicit, documented product/build/capability exclusions, such as reduced Tizen functionality. Cite the exclusion and preserve an accurate unsupported state or usable handoff. Existing absence is not evidence of an intentional exclusion. If required parity remains unfinished, link the work and report the change as incomplete for those targets; a follow-up issue alone does not establish parity.
- Review real entry points, caller/model/service/store behavior, role/profile authority, cancellation and stale results, cache keys/invalidation, durable outcomes, localization/accessibility, and success/empty/partial/stale/error states. A missing notice, warning, retry or usable recovery is a functional defect. Check for unreachable/stubbed paths and invented success or fallback logic.
- Performance is a highest-priority concern alongside correctness and privacy. Raise every credible negative effect and concrete opportunity for a gain, including optimizations present on another platform. Consider latency, frames/scroll/focus, CPU, memory, energy, decoders, network/I/O, caches, duplicate work, hidden/background tasks and service throughput/cost. Do not defer performance as cosmetic cleanup or suppress an opportunity because it is not yet measured.
- Distinguish reproduced/source-supported defects, investigations, measured gains and proposed optimizations. Record the mechanism, affected workloads/targets and comparison needed; never invent performance savings. Use matched before/after measurements where feasible. Resolve a regression introduced by the change or obtain explicit acceptance of its tradeoff before calling it complete. Follow existing device-recording instructions.
- Record every additional defect, parity gap, missing meaningful test, performance regression or optimization opportunity discovered while working. Search existing issues/PRs first. Add same-scope findings to the current issue; otherwise update a matching issue or create a focused issue in the owning repository and link it from the originating issue and audit tracker. Include trigger/workload, expected/actual behavior, source evidence, impact, confidence/counterevidence and useful acceptance. File uncertain items as investigations. Creating/linking these issues is explicitly authorized; do not ask permission again. If filing is blocked, retain a complete draft and report the blocker. Keep private implementation evidence out of public issues.
- Prefer E2E or real production-path integration that verifies visible behavior, failure/retry, cancellation/profile replacement and durable readback. Add focused unit tests for meaningful invariants, not mechanical implementation mirrors. Distinguish source/simulator checks from device, engine and performance qualification.
- Completion must include a result for every app target (changed/checked, explicit exclusion, not applicable with reason, or unverified with linked work), actual tests and their limits, performance findings/opportunities, and all new/reused follow-up issues. Do not claim app-wide correctness from a bounded feature check. Reporting discoveries does not automatically authorize unrelated features, deployment or paid pipeline runs.

The shared completion record and ongoing audit are maintained in [Den tracker #481](https://github.com/oxyc/den/issues/481#standing-implementation-rule). These rules stand on their own when the private tracker is unavailable.
