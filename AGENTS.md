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

## Playback: subtitles never switch the source

**Never start on, or switch to, Den Remux for subtitles unless the viewer explicitly switches to it.** A switch
replaces a stream that plays fine, takes seconds to tens of seconds, and on iOS loses the tap that started playback;
subtitles never justify it on their own. A subtitle the current stream can't show is offered as an explicit "Switch to
Den Remux" in the subtitle menu instead. Viewer actions that need another stream (choosing AirPlay, a release, the
Source switch) may replace it.

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

## Testing

- Do not add a regression test mechanically for every change. Trivial styling changes, copy edits, and straightforward substitutions of an existing shared component usually need the relevant static checks, not a new test.
- When a regression test is warranted, prefer an end-to-end test of the user-visible behavior over a component or unit test. Cover the real route and interaction across the browser boundary when practical.
- Use unit tests for isolated logic with meaningful branches, invariants, or failure cases that end-to-end coverage would make slow, opaque, or impractical.
- Keep tests proportional to the risk. Do not assert implementation details merely to prove that a small refactor happened.

## What deserves fixing

Den is a household app: one owner, a few family members, one Apple TV, a homelab box. There is no
adversary inside the household, and diagnostics go to our own already-redacted log collector. Judge
every finding against that, not against a bank.

**Worth fixing (and filing, if you can't fix it now):**
- A person can hit it in normal use and sees something wrong, missing or stuck: wrong audio
  language, skip-credits at the wrong time, no next episode, an empty row, a frozen overlay.
- Data people care about is lost or wrong: watch progress, seen marks, watchlist, library.
- A security hole reachable from the public internet (den-edge public names, public media listener).
- Slowness a person can feel, with a measurement or a trace showing it.
- A failing or flaky gate (`make verify`, Playwright, the dataset daily run).

**Not worth an issue, a PR or a comment** — don't file these, don't fix them in passing:
- Hypothetical failures of local storage: Keychain/SQLite/UserDefaults/filesystem refusing a write,
  "verify by readback", "fail closed when unreadable", rollback-of-a-failed-rollback, quarantine.
- Numeric edge cases nobody hits: overflow, saturation, non-finite values, exhausted clocks/epochs.
- Races and "fence to the exact profile/authority" work without a reproduced user-visible symptom.
- Removing identifiers from our own diagnostics.
- Parity for its own sake. Platforms may differ internally; only a user-visible wrong result counts.
- Localizing rare error or recovery copy, "qualify on hardware" chores, audit/tracker issues.
- Performance "opportunities" without a measurement of a felt problem.
- Bundle-size bookkeeping. Don't write size records into this file or into PRs.

**How to work:**
- Do the task you were given, then stop. Don't audit neighbouring code looking for more.
- Note anything else you noticed in one line in your final report. File an issue only if it meets
  the bar above; at most three per session, after searching for an existing one. Never file batches.
- Smallest fix for the reported symptom, one PR per issue. A PR over ~400 changed lines, or one
  touching more than one client, needs the owner's go-ahead first.
- Don't leave draft PRs behind: finish it to mergeable or close it.
- Fix the same bug on another client only when that client shows the same user-visible symptom.
- Tests prove the symptom is fixed (E2E/integration preferred). Don't add tests for the cases in the
  "not worth it" list.
