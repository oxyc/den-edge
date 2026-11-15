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
