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

## Bundle budget records

- AirPlay's way back (#1202) was measured on matched local production builds at main `71f28b69` and the PR head: the
  complete non-translation delta moves 128,173 → 128,691 (+518), translations 51,786 → 51,833 (+47: "Playing on
  AirPlay" and "Stop AirPlay", leaving 7 under the translation ceiling), and startup 11,025 → 11,012 over the fixed
  baseline (-13, chunk-hash churn). All of the growth is in the lazy Player chunk: the
  AirPlay bar above the picture (Close and Stop AirPlay, which opens Safari's picker), the one-second settle of a lost
  wireless target, the reload at the receiver's position once playback is back on this device, and the switch to TorBox
  where the cast page offers no AirPlay. The first draft measured +658 with five phrases (translations 51,892, over
  their ceiling); dropping three phrases brought it to +530, and reusing the shared `Button` for Stop AirPlay instead of
  its own CSS to +483 (at main `f4123e9f`). The TorBox switch's label reuses `player.switchTo`, so no phrase is added
  for it. It must sit with the element's WebKit events it answers; another split would add a request mid-playback.
  The complete ceiling advances from 128,256 to 128,768, the smallest 128-byte boundary containing it (retaining 77);
  the startup and translation ceilings are unchanged. It adds one bounded 1 s timer per wireless loss and no request, polling or dependency; the reload
  re-fetches the playlist once when AirPlay ends.

- An audio choice on a TorBox stream that names no audio tracks (#1419) was measured on matched local production builds
  at main `1184de9d` and the PR head: the complete non-translation delta moves 128,142 → 128,173 (+31; +109 at main
  `dce686c0`, the rest chunk-hash churn), translations 51,722 → 51,786 (+64, one phrase), and startup 11,019 → 11,025
  over the fixed baseline (+6, within its cap). It is all in the lazy Player chunk: the Audio section's "Switch to Den
  Remux" row, which reuses the existing switch and its label, and the dock's Audio & subtitles button shown for it.
  It fits the existing 128,256 complete ceiling (retaining 83); no ceiling changes. It adds no request, timer or
  dependency.

- Scoping retained availability to the exact household, profile and Scout (#1156) was measured locally on the PR head
  merged with main `e3940b7e` against that main built the same way: core delta 128,142 (main 128,000, +142),
  translations 51,722 (unchanged), startup delta 11,019 (main 10,744, +275). The growth is the authority admission
  `ProfileSession` makes before it configures the household, and `Availability`'s reset, restore and opaque
  namespace, with the local authority digest that release memory now shares. The fence must hold before any poster
  asks, so a lazy split cannot reduce the startup graph. The complete ceiling advances from 128,000 to 128,256
  (retaining 114) and the startup ceiling from 10,752 to 11,136 (retaining 117, factor 0.05475 to 0.05671); the
  translation ceiling is unchanged. It adds no request, timer, listener or dependency.

- Keeping the old link when a legacy key-reset marker is unreadable (#1252) was measured on the PR head rebased onto
  main `f4123e9f`: core delta 127,951 locally (the hosted gate measured 127,889 with a longer log line; the figure moves
  with chunk-hash churn), translations 51,722 (unchanged), startup 207,129 (unchanged). The growth is one storage probe
  and one branch in `forgetMoved`, in the links module every Browser graph carries, so a lazy split cannot reduce the
  complete graph. The complete ceiling advances from 127,872 to 128,000 (retaining 49); the translation and startup
  ceilings are unchanged. It adds no request, timer, listener or dependency.

- Ending a read held before first paint (#1378) was measured by the hosted gate, and reproduced locally, on the PR head
  rebased onto main `5a8eef62` (core delta 127,740, translations 51,722, startup 206,998): core delta 127,771 (+31),
  translations 51,722 (unchanged), startup 207,001 (+3; chunk-hash churn, the change is Worker-only). The growth is one
  branch in the library Worker's `foreground-ready` handler. That is the Worker's own refresh loop, carried by every
  Worker graph, so a lazy split cannot reduce the complete graph. The complete ceiling advances from 127,744 to 127,872
  (retaining 101); the translation and startup ceilings are unchanged. It adds no request, timer, listener or
  dependency.

- Settings retries (#1045, #1296) were measured by the hosted gate on the PR head rebased onto main `20463fa0`
  (core delta 127,284, translations 51,689): core delta 127,629 (+345), translations 51,722 (+33), startup 206,967
  (within its cap). The core growth is all in the lazy Settings route: the profile-preference and SIMKL-disconnect
  generation/session fences that keep a late result from landing on a replaced session, and their Retry controls.
  Turning the named failure objects into a typed tuple and reusing existing phrases for the SIMKL notes removed 53
  bytes from the earlier draft. The one new phrase, "Saved, but not shown.", says a profile language was saved but could not be
  presented. The fences must sit where each write starts and settles, so a lazy import cannot reduce the complete
  graph. The complete ceiling advances from 127,360 to 127,744 (retaining 115) and the translation ceiling from
  51,712 to 51,840 (retaining 118); the startup ceiling is unchanged. It adds no request, timer, listener or
  dependency.

- A return visit with unsent work (#1401) draws what the browser holds at once and sends the work on the first
  foreground refresh; a cached opening pull takes the log's write lane only once adopted, and a change a
  non-reporting pass makes is said by the next refresh. All of it is in the library Worker's `log.ts` (about +76 gzip
  bytes as one minified file). CI measured the merged head at 127,284 against #1158's 127,360 ceiling (an earlier
  draft measured 127,368 on main `082bcab6` before its redundant body cancels were dropped). No ceiling changes. It
  adds no request, timer, listener or dependency.

- Localizing the profile switcher (#1158) was measured by the hosted gate at exact base `d4d42ac1` (core delta
  127,190, translations 51,549, startup 207,012) and the PR head: translations 51,689 (+140), core delta 127,242
  (+52), startup 207,061 (+49, within its cap). The translations are the two new PIN-field labels, the
  parameterised Owner-PIN and Kid age lines and the `profile` fallback. The first draft measured 51,749; dropping
  the two fragments the parameterised Owner-PIN line replaced removed 60. The core growth is the `i18n` calls around
  the switcher's existing copy and its description helper. The catalogs are already lazy, and lazily importing the
  switcher dialog would add a request to every open while still counting in the complete graph. Main kept 35
  translation bytes and 42 complete-graph bytes, so the translation ceiling advances from 51,584 to 51,712
  (retaining 23) and the complete ceiling from 127,232 to 127,360 (retaining 118). The startup ceiling is
  unchanged. It adds no request, timer, listener or dependency.

- Refused-start fresh-write fencing (#1392) was measured on clean, matched production builds at exact base
  `d4d42ac1` and production/test head `08e93a63`, from equal-length detached worktree paths with identical lockfile
  dependencies and Node/Vite toolchains. Browser startup moves 207,038 → 207,012 gzip bytes (-26), while its
  complete JS/CSS graph moves 904,526 → 904,529 (+3); independently lazy Spanish/Swedish catalogs remain 51,549,
  leaving the non-translation graph 852,977 → 852,980 (+3). LG/webOS startup moves 242,008 → 242,021 (+13),
  complete moves 1,003,457 → 1,003,609 (+152), and non-translation moves 951,908 → 952,060 (+152).
  Supported Tizen 8 startup moves 242,716 → 242,697 (-19), complete moves 1,324,069 → 1,324,155 (+86), and
  non-translation moves 1,272,520 → 1,272,606 (+86). Reduced Tizen 3 startup moves 193,680 → 193,683 (+3),
  complete moves 2,405,024 → 2,405,205 (+181), non-translation moves 2,353,381 → 2,353,562 (+181), and its
  raw JS/CSS graph moves 8,350,689 → 8,351,714 (+1,025). Every target retains the same
  JS/CSS file count (Browser 120, webOS 140, Tizen 8 151, Tizen 3 98) and unchanged translation graph (51,549 on
  Browser/modern TV, 51,643 on Tizen 3); all target verifiers pass, and emitted products contain no source maps or
  named coverage/instrumentation artifacts. The hosted exact-head budget gate also passes at startup 207,012,
  complete 904,529, translations 51,549 and core delta 127,190, preserving 42 bytes of its existing margin.
  Before retaining the delta, the implementation consolidates repeated refusal-time checks behind the existing
  exact-`LibraryLog` `refusalWaiting` accessor and reuses the existing acknowledged-document and household-scope
  helpers instead of adding another authority owner, queue, timer or transport. The fence must remain at the
  existing serialized Worker write boundaries so a refusal established by an earlier held write also stops queued
  document, settings, exact-CAS and bulk-row sends; moving it behind a page-level lazy import would omit non-page
  writers or add an asynchronous authority gap. It adds no module, dynamic import, dependency, translation, route,
  polling, task, listener, request during the wait, cache or persisted schema. No budget changes are required.

- The missing-library recovery (#1212) was measured on matched production builds at base `251484fd` and the repair.
  Only the typed `refused-start` status is on the startup path: the notice copy, its Open Linked devices action and the
  row reveal are the lazy `MissingLibraryNotice` chunk (`MissingLibraryNoticeScreen`), fetched only while a library is
  refused. Ordinary Browser startup moves 10,512 → 10,642 over the fixed baseline (+130). appMain accounts for +102:
  +20 is the classification itself (the session getter and the page codec case; measured by building the status
  alone), the rest the smallest lazy wiring (registry entry with its hashed chunk path and preload deps, load effect,
  component slot). The new chunk also renumbers the shared import map, about +3 in each of six other startup chunks.
  The complete non-translation graph moves 126,292 → 127,187 (+895): the lazy chunk +666 and the Worker's status and
  codec +40, the rest that renumbering. ES/SV catalogs move 51,439 → 51,549 (+110). Measured and
  rejected: the copy and action eager in `LibraryStatus` (startup +206); the notice importing Settings' `rows` (split
  `rows` into its own chunk, adding a request to every Settings open); a `pageVisibility` import (its own startup chunk,
  +148 and a request); and an `{#await import()}` slot (would pull Svelte's await runtime into startup, which no eager
  code uses yet). The reveal opens the row through its own button and focuses it once its page is shown, so Settings
  and its rows are unchanged. Main left 44 bytes of complete-graph margin and 17 of translation margin: the complete
  ceiling advances to 127,232 (45 bytes of margin) and the translation ceiling to 51,584 (35); the startup cap is
  unchanged. No request outside that state, timer, polling, listener or dependency is added.
- Consuming a segment scan the current play started (#1201) was measured on matched production builds at base
  `053a769e` and the change. Ordinary Browser startup moves 10,529 → 10,512 over the fixed baseline (-17 gzip bytes,
  minification; no startup code changed), while the complete non-translation graph moves 126,176 → 126,292 (+116);
  translations are unchanged. All of it is in the existing lazy Player chunk: the re-ask schedule (the Apple TV's
  45 s, 120 s and last-12-minutes re-asks), the per-episode reset and reading den-edge's settled-miss
  `x-den-skipdb`. It must sit with the player clock that drives it; no timer, interval, listener or request beyond
  those three re-asks is added. The complete ceiling advances to 126,336, the smallest 128-byte boundary containing
  the build (44 bytes of margin); the startup and translation ceilings are unchanged.
- Bounded Reel prepare/plan/transport requests and the fail-closed relay fallback (#1257/#1258) were measured on
  matched production builds at base `2d35b3f1` and the repair. Ordinary Browser startup moves 10,725 → 10,529 over
  the fixed baseline (-196 gzip bytes), while the complete non-translation graph moves 125,524 → 126,176 (+652);
  translations are unchanged. About 133 bytes are the four deadlines and the local-page relay check; about 520 are the
  poorer compression of Edge's transport negotiation as its own lazy `reelTransport` chunk. That chunk is fetched only
  the first time a carried trailer is tried, and it imports nothing at runtime: a lazy module importing `reel.ts`
  pulled it out of the eager PosterCard chunk and fragmented `ipv4`/`retryAfter` (-1,142 startup, +1,381 complete),
  while keeping everything inline cost +118 startup. Trailers are second-class, so the startup saving wins. The
  complete ceiling advances to 126,208, the smallest 128-byte boundary containing the build (32 bytes of margin); the
  startup and translation ceilings are unchanged.
- The auto-skip grace period (#1208) was measured on matched production builds at base `0321382f` and the repair.
  Ordinary Browser startup moves 207,115 → 207,121 gzip bytes (+6, minification; no startup code changed), while
  the complete graph moves 902,103 → 902,753 (+650). Independently lazy Spanish/Swedish catalogs account for +177,
  leaving the non-translation graph 125,051 → 125,524 (+473), all in the existing lazy Player chunk: the pure
  countdown decision, the countdown and its once-spoken notice, pause/seek cancellation, the session/release fences
  and the desktop Skip button's missing `pointer-events` (it could not be clicked). It must sit with the player clock
  that decides it; another split would add a request mid-playback and cannot reduce the complete graph. No timer,
  interval, request or dependency is added: the existing `timeupdate`/progress tick drives the deadline, and
  cancellation reuses the element's existing `pause`/`seeking` handlers. The complete non-translation ceiling advances
  from 125,056 to 125,568, the smallest 128-byte boundary containing the matched build, retaining 44 bytes. Startup
  and translation ceilings are unchanged.
- Broader profile-lifecycle availability (#544) was measured on matched production builds at base `1fdda1db` and
  production head `572d327d`. Ordinary Browser startup moves 206,577 → 206,567 gzip bytes (-10), while its
  complete JS/CSS graph moves 895,308 → 895,653 (+345). Independently lazy Spanish/Swedish catalogs move
  50,827 → 51,060 (+233), leaving the non-translation graph +112. LG/webOS startup moves 241,263 → 241,247
  (-16), complete 994,580 → 994,924 (+344), translations +233 and non-translation graph +111. Supported
  Samsung/Tizen startup moves 241,885 → 241,880 (-5), complete 1,315,013 → 1,315,376 (+363), translations
  +233 and non-translation graph +130. Reduced Tizen 3 startup moves 193,393 → 193,391 (-2), complete
  2,392,118 → 2,392,448 (+330), translations 50,922 → 51,151 (+229) and non-translation graph +101.
  Before retaining these deltas, the initial eager keyed English messages were removed: Browser and modern TV now
  consolidate the notice in the existing lazy `ContentSection` and existing independently lazy locale chunks, while
  reduced Tizen 3 reuses its already separate Settings route. Another dynamic import would add a request to render
  one paragraph and cannot reduce the complete graph; a further split for the old Tizen 3 engine would likewise add
  a request to its small reduced route without removing the route or its truthful viewer-only state. The change adds
  no dependency, network request, task, listener, timer, cache, persistence or background work. Clean base already
  exceeds the fixed Browser startup allowance by 28 bytes (10,181 versus 10,153); this change improves startup by
  10 bytes but remains 18 over, with recalibration owned by #1282 rather than absorbed here. No budget is changed:
  the Browser complete non-translation ceiling retains 3,437 bytes, modern translations retain 140 bytes and the
  reduced-Tizen translation ceiling retains 49 bytes.

- Exact profile authority and truthful tracker capability (#534) were measured on matched production builds at
  base `87c470e9` and production/test head `4027875e`. Ordinary Browser startup moves 206,566 → 206,545 gzip
  bytes (-21), while the complete graph moves 894,656 → 895,131 (+475). Independently lazy Spanish/Swedish
  catalogs account for +237, leaving the non-translation graph 844,161 → 844,399 (+238). WebOS startup moves
  241,242 → 241,206 and its non-translation graph 943,464 → 943,558 (+94); supported Tizen moves 241,877 →
  241,896 and 1,263,906 → 1,264,160 (+254). Reduced Tizen 3 keeps tracker administration compiled out and adds
  no tracker affordance: startup moves 193,379 → 193,378, the non-translation graph 2,347,707 → 2,347,956
  (+249 gzip), and the raw JS/CSS graph 8,328,215 → 8,329,668 (+1,453 bytes).
  The exact Owner activity-model lease and generation fence must stay beside the existing eagerly mounted Settings
  authority so a household/profile replacement retires both selectors before either can publish; splitting that
  compact selection would add a request or duplicate authority state. Presentation remains in the existing lazy
  Settings chunk, locale copy remains independently lazy, and Tizen 3's existing compile-time Settings boundary
  removes the unsupported tracker controls. The change adds no dependency, timer, polling, cache, provider call,
  decoder, background work or healthy-path network round trip. No budget changes are required: the independently
  enforced startup ceiling retains 4 bytes, the complete non-translation ceiling retains 3,631 bytes, and the
  fixed 51,200-byte translation ceiling retains 468 bytes.
- Download-management truthfulness and reduced-Tizen handoff (#525) were measured on matched production builds at
  exact base `5b15e694` and production source `bfae8b5e`. Ordinary Browser startup moves 206,566 → 206,555 gzip
  bytes (-11), while its complete graph moves 894,656 → 894,790 (+134); independently lazy translations move
  50,495 → 50,586 (+91), leaving the non-translation graph 844,161 → 844,204 (+43). WebOS startup moves
  241,242 → 241,219 (-23), its complete graph 993,959 → 994,019 (+60), translations 50,495 → 50,586
  (+91), and non-translation graph 943,464 → 943,433 (-31). Supported Tizen startup moves 241,877 →
  241,937 (+60), its complete graph 1,314,401 → 1,314,703 (+302), translations 50,495 → 50,586 (+91),
  and non-translation graph 1,263,906 → 1,264,117 (+211). Reduced Tizen 3 startup moves 193,379 → 193,387
  (+8), its complete graph 2,398,293 → 2,391,622 (-6,671), translations 50,586 → 50,679 (+93), and
  non-translation graph 2,347,707 → 2,340,943 (-6,764); its JS/CSS file count falls from 98 to 96 because the
  management screen is absent and only the browser handoff remains.
  The first implementation put handoff copy in the eager Library shell and the shared lifecycle predicate in an
  eager status module. Moving the handoff behind the target-specific lazy Downloads screen and the predicate into
  a module imported only by the lazy management screen and download authority removed that avoidable startup cost.
  Browser's fixed-baseline budget delta improves from the base's pre-existing +10,170 to +10,159; its absolute
  failure remains owned by #1282, and this repair changes no budget. The retained supported-Tizen growth is the
  smallest reviewed cancellation-refusal authority contract plus independently lazy EN/ES/SV copy. Authority must
  remain in the shared service Worker so a refused upstream cancellation cannot be presented as a durable removal;
  moving it behind DownloadsPage would omit the enforcement from non-page callers or duplicate authority. Another
  presentation split would add a request at the recovery action and cannot reduce the complete graph.
- Exact-current Owner PIN replacement/removal (#1145) was measured on matched production builds at base
  `7fff9db5` and production source `d0fa72a4`. Ordinary Browser startup moves 206,062 → 206,150 gzip bytes (+88), while the
  complete graph moves 890,492 → 892,631 (+2,139). Independently lazy Spanish/Swedish catalogs account for +707,
  leaving the non-translation graph 840,831 → 842,263 (+1,432). WebOS startup moves 241,848 → 242,284 and its
  non-translation graph 940,936 → 942,859 (+1,923); supported Tizen moves 242,580 → 242,903 and 1,261,627 →
  1,263,294 (+1,667). Reduced Tizen 3 compiles the editor and its content-provider dependencies out while retaining
  truthful Kid browser handoff and Visitor device-local recovery: startup moves 193,377 → 193,379 (+2), the complete
  non-translation graph 2,354,772 → 2,346,643 (-8,129 gzip), and the raw JS/CSS graph 8,349,411 → 8,325,184
  (-24,227 bytes).
  The PIN form remains in the existing lazy Settings chunk and the ES/SV copy remains independently catalog-lazy.
  The protocol-version gate, exact-row compare-and-swap, current-PIN authentication, serialized profile-topology
  guard and durable replay prevention must stay with the shared Worker that owns the row; another split would add an
  authority request or duplicate the admission state before Settings can recover. The change adds no dependency,
  polling, timer, cache, background task, provider call or healthy-path extra network round trip. One explicit
  submit remains one library command and, on success, one settings-row write. The startup ceiling advances from
  9,728 to 9,856, the smallest 128-byte boundary containing the 9,754-byte matched graph (102-byte margin); the
  complete non-translation ceiling advances from 115,072 to 116,480, containing 116,473 with 7 bytes of margin.
  The separate translation ceiling remains 51,200 with 832 bytes of margin.
- Persistent per-title Kid approval management (#530) was measured on matched production builds at exact current
  main `fc04556c` and production source `599d552a`. Ordinary Browser startup moves 206,154 → 206,542 gzip bytes
  (+388), while the complete graph moves 897,592 → 898,475; independently lazy Spanish/Swedish catalogs account
  for +127, so the non-translation graph moves 847,224 → 847,980 (+756). The exact mutation admission, Owner/Kid directory
  generation fences and durable outcome mapping remain in the eagerly mounted Library/profile coordinator because
  they own the existing Browser writer before a dialog may open. The TV-only handoff was removed from shared
  `TitleActions` and placed in the already lazy Detail chunk; moving the Browser authority there would duplicate or
  delay the writer, while another Detail split would add a request to the sole recovery handoff. Locale copy remains
  independently lazy. Reusing the canonical title route and the existing build-owned Web origin keeps the TV
  handoff out of a second route/origin helper. A compile-time TV replacement removes the unreachable Browser editor
  after current bundling retained it despite a constant-false template branch: WebOS startup moves 242,299 → 241,236
  (-1,063) and its non-translation graph 963,753 → 963,097 (-656); supported Tizen startup moves 242,977 → 241,875
  (-1,102) and its non-translation graph 1,284,341 → 1,283,610 (-731). Reduced Tizen 3 likewise retains only the
  exact-title handoff: startup is unchanged at 193,729, the complete non-translation graph moves 2,349,637 →
  2,348,842 (-795), and the raw JS/CSS graph 8,331,899 → 8,329,726 (-2,173). No dependency, polling, timer,
  healthy-path request or background work is added; one existing mutation runs only after explicit Owner PIN
  submission and reads back through its existing durable profile directory. The startup ceiling advances to the
  smallest 128-byte boundary, 10,240 over baseline; the proportional bound `0.0517` is tighter and retains 7 bytes.
  Exact clean main itself measures a 121,434-byte non-translation delta, 3,802 above its committed 117,632 ceiling;
  #1282 owns that pre-existing reproducibility defect. Its separate clean-main calibration is 121,472 (38-byte
  margin), after which #530 advances the complete-graph ceiling to the smallest boundary, 122,240, retaining 50
  bytes. The fixed 51,200-byte translation ceiling remains unchanged with 705 bytes of margin.
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
  from current main's 101,632 to 101,760, retaining 93 bytes on the combined build.
  After merging current main through `75f1cda2`, authority-scoped series-release recall was measured on exact matched
  production builds: startup moves 206,135 → 206,187 gzip bytes, the complete graph 892,596 → 893,756,
  translations stay 50,368, and the complete non-translation graph moves 116,438 → 117,598. Of the 1,160-byte
  complete-graph increase, 1,141 is in the existing lazy Player chunk (48,854 → 49,995) and 58 is in the
  always-loaded app chunk (110,634 → 110,692), partly offset by 39 bytes elsewhere. Consolidating the five
  authority fields into a tuple removes their repeated eager property names. The authority/remount coordinate must
  remain in always-loaded Library so a replaced profile, library, household or source cannot publish delayed recall;
  the digest, retained-memory codec and bounded source lookup already live with lazy Player. A further split cannot
  reduce the isolation gate's complete-graph accounting and would add a request before the first session lookup. The
  existing startup ceiling, 9,856 bytes above baseline, retains 65 bytes; the complete non-translation ceiling
  advances to 117,632, the next 128-byte boundary, retaining 34 bytes; the translation ceiling is unchanged.
  Bounding the shared binge console records then moves the matched production build's startup 203,797 → 203,812
  gzip bytes and complete non-translation graph 101,667 → 101,700, retaining 7 and 60 bytes respectively without
  another budget change;
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
- Making “Remember my choice” the playback-source default was measured on matched current-main/head production
  builds after rebasing onto `7fff9db5`: startup moves 206,062 → 206,058 gzip bytes (-4), and the complete
  non-translation graph moves 840,831 → 840,841 (+10); translation catalogs remain 49,661 bytes. Player owns the
  single Library fallback, removing a duplicate default expression; Settings retains its defensive fallback because
  the cross-version protocol field is optional. The change only reverses existing default branches and persists both
  explicit policy choices compatibly. The final CI repair verifies that the release graph contains its separately
  cached assistant projection Worker and gives only the routed multi-entry E2E build an explicit test entry; that
  entry and client do not ship. It adds no dependency, production request, timer, listener, background work or
  bundle-budget allowance; the existing startup and complete-graph ceilings retain 66 and 21 bytes respectively.

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
