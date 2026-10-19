# Smart TV local testing

The first target is an LG C2/C4. Samsung is a later, separate validation pass.
These are separate Vite/Svelte outputs from the existing screens and domain code,
not a fork of the web app. No release or deployment is part of this change.
Build and preview the TV-targeted bundle locally:

```sh
cd web
npm ci
npm run build:tv:webos
npm run preview:tv:webos -- --host 127.0.0.1
npm run test:e2e:tv
```

For desktop preview open `http://127.0.0.1:4173`. Arrow keys navigate; Select is Enter,
Back is Escape. In a text field, Select enters editing and Back leaves editing.
Add `?tv-diagnostics=1` for a safe capability report (no library keys).
Its **Run device checks** action performs disposable IndexedDB write/read, Web Crypto,
and bundled Worker/Crypto/WASM probes. It is reachable by remote even if app startup fails.

Set `DEN_EDGE` to your running Den Edge origin. The existing defaults are the
homelab's LAN addresses; override `DEN_ATLAS`, `DEN_REEL`, and `DEN_REMUX` if those
services live elsewhere. The preview proxies API calls so pairing and Worker requests
stay same-origin. It does not start or deploy any backend.

### Reach it from the LG

Use a dedicated HTTPS hostname such as `tv.example.com`, leaving the existing browser
hostname unchanged. An existing HTTPS reverse proxy or a Cloudflare Tunnel published
application can point that hostname at `http://127.0.0.1:4173` on this laptop:

```sh
DEN_TV_HOST=tv.example.com DEN_EDGE=http://your-den-edge:8094 npm run preview:tv:webos -- --host 127.0.0.1
```

`DEN_TV_HOST` permits only that explicit hostname; it does not create DNS, start a
tunnel, or disable the development server's host checks. The proxy terminates trusted
HTTPS, so the TV gets Web Crypto without trusting a locally generated certificate.
Use the actual hostname in the launcher package. Keep it stable: pairing and local
storage belong to that origin. Serve this build at the hostname root, not `/tv/`.

[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) only works
when the TV has a route into the tailnet. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
works without a TV VPN client but makes the endpoint public, as does a
[published Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/).
Neither is started by these scripts. Only expose the production preview, not Vite HMR;
review access to the proxied backend before making a public endpoint. Do not assume
an interactive Access login will work for the TV's media requests.

Alternatively, for LAN-only HTTPS, set `DEN_TLS_CERT=/path/cert.pem` and
`DEN_TLS_KEY=/path/key.pem` on the preview command and use `--host 0.0.0.0`. The TV
must trust the certificate and resolve its hostname; a laptop-trusted `mkcert` CA
alone does not make the TV trust it.

The URL must be explicit HTTPS. `localhost` on a TV is the TV itself, not the
developer laptop; use trusted LAN HTTPS (or a real staging host) and ensure the
TV can resolve and reach it. No command here installs or deploys an app.

## LG webOS

LG documents a `hosted_webapp` app: a small packaged app has `appinfo.json` and
redirects its `index.html` to content on a remote server. The generator emits
that shell, with an app ID, three-part version, 1920x1080 metadata, an 80x80
launcher icon and a 130x130 large icon. If `ares-package` is installed it creates an `.ipk` in
`web/tv-packages/webos/packages`; otherwise the command exits nonzero and leaves
a ready shell in `web/tv-packages/webos/shell`. Installation/testing on a real TV
is a later manual step using LG webOS TV CLI, Developer Mode, or the simulator.
To generate a launcher for the hostname you have configured:

```sh
npm exec --yes --package=@webos-tools/cli@3.2.6 -- node scripts/tv-package.mjs webos --url https://tv.example.com/ --version 0.1.0
```

`node scripts/tv-package.integration.mjs` separately runs the real LG SDK with a
placeholder URL, checks the `.ipk` and icon dimensions, and keeps its artifacts
under `tv-packages/smoke-test`. That smoke package cannot open a working Den server.
Neither command installs anything on a TV.

References: [webOS hosted web apps](https://webostv.developer.lge.com/develop/getting-started/web-app-types),
[appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json),
[CLI packaging](https://webostv.developer.lge.com/develop/tools/webos-tv-cli-dev-guide).

The C2 baseline is the Chromium 87 generation and C4 is Chromium 108. Treat
those as useful compatibility baselines, not proof of every codec/API path.

The TV entry imports `src/tv/compat.ts` in the page and each owned Worker. The
source actually uses `Array.prototype.at`, `String.prototype.at`,
`Object.hasOwn`, `structuredClone`, `crypto.randomUUID`, and
`AbortSignal.reason`/`throwIfAborted`/`timeout`/`any`; the TV bundle supplies
polyfills for all of these. It still requires secure-context Web Crypto,
Workers, IndexedDB and WebAssembly. A genuine Linux Chromium 87 run rejected the
browser core's two WebAssembly tables, before the library could open. TV builds
therefore resolve the same policy to `src/vendor/den-core-tv`: the exact same
source-manifest hashes, compiled without reference types, including the Rust
standard library. The browser artifacts are unchanged. The TV build checks both
source-version parity and emitted WASM hashes, so a future shared-core update
cannot silently leave TV policy behind. `node scripts/test-tv-core.mjs` executes
the shared golden policy vectors against both binaries.

To regenerate the TV artifacts, use Rust and wasm-bindgen versions recorded in
the browser core's `SOURCE.json`, install the matching `rust-src` component, then
run `node scripts/build-tv-core.mjs /path/to/pinned/den-core`. The command verifies
every source hash before compiling; `WASM_BINDGEN` can name an explicit CLI.
Ordinary builds use the checked-in artifacts and need no Rust toolchain. The
maintenance build enables `build-std` on that pinned compiler with
`RUSTC_BOOTSTRAP=1`, disables reference types in both the application and std, and
omits the debug-name section. It does not alter shared policy source.

The same actual-engine check found that Chromium 87 drops Svelte's generated
`:where(.svelte-…)` selectors and ignores `aspect-ratio`. A TV-only PostCSS pass
retains the scope classes without `:where`; TV geometry has explicit height
fallbacks. This changes descendant-selector specificity in TV output, so the
real navigation/geometry checks matter. Neither transform affects browser CSS.
Old desktop-engine evidence still does not establish TV firmware or codec support.

## Samsung Tizen

The packaged path is explicitly opt-in and requires an HTTPS
`DEN_TV_API_ORIGIN` plus a named Tizen certificate profile:

```sh
DEN_TV_PACKAGED=1 DEN_TV_API_ORIGIN=https://den.example npm run build:tv:tizen
DEN_TV_API_ORIGIN=https://den.example node scripts/tv-package.mjs tizen --url https://den.example --profile MyCertificateProfile
```

This copies the actual bundle into a Tizen shell and writes `config.xml`; it
exits nonzero when the CLI/profile is unavailable. `--prepare` generates and
validates the unsigned shell without invoking the SDK. Local assets and dedicated
Workers remain in the package; app routes use `index.html#/…` and only allowlisted
Den API paths move to the explicit API origin. The production-package E2E suite
serves physical files without SPA rewrites or an API proxy and exercises encrypted
pairing, Worker sync, reload, detail/Back and actual HLS playback across origins.
It does not claim that arbitrary remote
content is an approved Samsung hosted app: Samsung says hosted/cloud apps are
normally not accepted without Content Manager approval, and Tizen APIs are not
available in hosted apps. A signed `.wgt` also requires Tizen Studio and a
configured certificate profile. It never installs.

References: [Samsung hosted applications Q&A](https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html),
[web app configuration and privileges](https://developer.samsung.com/smarttv/develop/guides/fundamentals/configuring-tv-applications.html?device=htv),
[Tizen CLI packaging](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html?device=htv),
[testing on a TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).

The packaged Samsung target is Tizen 8.0 (2024 generation, Chromium 108) or newer.
That permits WebAssembly with `wasm-unsafe-eval` while keeping JavaScript eval and
remote scripts prohibited. Earlier Samsung engines require the broader
`unsafe-eval` permission, which Samsung's submission guidance disallows. The
manifest declares this minimum; older Samsung TVs are not qualified. LG's separate
build still targets Chrome 85 for C2/C4 compatibility. Record the actual Samsung
model/firmware when testing; a package build or browser E2E run is not hardware proof.

The package allows dynamic network destinations for media/addons through WARP,
but applies a separate CSP restricting executable code to local assets. Production
HTML and the package test server enforce the same policy, including on Workers.
Only HTTPS external media/API origins are permitted. See the packaging README for
certificate/profile and publication artwork requirements.

The configured API must allow the installed widget's actual request origin through
`WEB_ORIGINS`. Determine that origin on the TV; do not globally allow `null` just
because a local-file widget might use an opaque origin. Browser package tests use
an explicit loopback origin and do not prove Tizen's file-origin security rules,
Worker loading or Web Crypto classification. HLS servers also need appropriate
CORS for playlists, segments, subtitles and preflights. Credentials still use the
shared exact-origin/path allowlists; external media hosts do not receive library keys.

The package suite also opens the built entry through `file://` and checks bootstrap,
Settings and remote Back. Only that test enables Chromium's local-file access flag;
the HTTP-package CORS/security journeys keep normal browser security. Chromium on
the test workstation reports `file://` as its origin. This test does not establish
Samsung's origin value or local-file permissions.

## Diagnostics and scope

On each TV record model, firmware, browser engine, URL, TLS certificate chain,
DNS/IP route, console errors, first paint, focus movement, media codec and
back/exit behavior. The shell listens for Escape/Backspace before redirecting,
but the remote app must own its router and platform-specific back handling.
The TV entry does not register a service worker. The existing library and recovery
Workers are dedicated Workers, not service workers despite the historical
`libraryServiceWorker.ts` filename. They remain required and get their own runtime
polyfills. Missing Web Crypto, Worker, IndexedDB or WASM support gives a readable
startup error with a focusable retry action.

The native Swift/tvOS app is a reference for product behavior, not evidence
that this web shell or its media path works on LG/Samsung. Local browser E2E
proves web behavior; only a real TV (or documented simulator) proves device
integration.

## Apple TV reference and intentional differences

`Shell/AppTab.swift` and `RootView.swift` inform the TV navigation: an icon-only
Search button first, followed by Home, Movies, Series, Watchlist and Settings.
The TV-only centered bar uses 24px labels, wider spacing and a filled focus pill;
Search opens the page's query editor instead of embedding a field in the bar.
Home links to the canonical `/` route, not the `/library` URL that bypasses client routing.
Poster menus are omitted on TV. Cards keep a single inset white artwork ring,
without a second outer link outline. Posters rest at 97% of their reserved surface
and ease to 100% on focus, retaining the slight zoom without crossing a shelf's
paint or overflow boundary. That geometry and ring treatment is shared with browser
keyboard focus; TV only raises the ring-width custom property from 3px to 4px.
Ordinary controls and composite picker/split-button shells consume the same width;
TV changes their accent ring to white and suppresses the focused inner hit surface,
so a remote exposes one ring even on the Chrome 85-class engine without `:has()`.
The TV Search editor follows the same rule: its ring encloses the icon and input as
one control. Shelf headings keep the shared single-line geometry instead of reserving
a second mobile line that short headings never use.
On coarse-pointer previews, Search is warmed without joining the initial browser bundle;
the route and editor focus complete inside the activating tap so mobile WebKit can open
its software keyboard. Remote focus provides the same intent warm-up on a TV.
The browser navbar and poster menus remain unchanged.

The reference inspected was `den/App/Den/Components/FeaturedHero.swift` and
`Screens/DetailView.swift`, not the hero's stale introductory comment. Its current
hero has one **Details** button. The shared TV billboard keeps one **More** link
to the detail page, with a noninteractive title; browser-only Play, Watchlist/Seen,
the full-slide link, pagination dots and the fullscreen shortcut are removed from
the TV hero. Thus an active TV slide has exactly one interactive element.
Watchlist/Seen and the available playback/source/trailer actions remain on the
shared detail screen. The normal browser presentation is unchanged.

`Screens/SearchView.swift` also informs TV Search: a full-width, 28px query editor
above a category rail and uniform 200×300 poster grid. The editor scrolls with the
page; the first result column's Left returns to the active category, and Right from
the rail enters results. Querying, debounce, filters, caching and paging remain
shared with the browser. A dense-result E2E journey covers keyboard editing,
row/column movement and detail/Back focus restoration.

Directional focus geometry is shared with the browser as progressive enhancement.
Normal browser Tab, Enter, editing, pointer input and component-owned arrow keys stay
native; the small geometry chunk is fetched only after Tab prefetches it or an
eligible focused control receives an arrow key. If that optional chunk is missing,
the page does not reload and native keyboard behavior remains usable. Production
Chromium and WebKit E2E fault-inject the missing and delayed chunk, so this contract
is checked without adding TV code to the browser's initial bundle.

This is not full native-tvOS parity. Native downloads, platform player menus and
codec/HDR behavior do not become available merely by reusing a screen. TV playback
reuses the existing source/session, retry and progress logic, with remote
play/pause/seek, a hideable controls overlay, and Back/visibility cleanup. LG's
webOS user agent explicitly selects native HLS. Desktop preview uses native HLS
where available and hls.js otherwise. Installed Samsung builds load the platform
Web API bridge before the app and lazily mount a TV-only AVPlay adapter. It reuses
the shared session/recovery/progress UI, waits for resume seeking before playback,
selects audio/native subtitle tracks and renders external WebVTT against AVPlay's
clock. Stale callbacks cannot mutate a replacement session. Unknown buffered seconds
and decoded-frame counts stay unknown rather than being fabricated from callbacks.
The adapter and its CSS are absent from browser and LG builds.

## Verification and browser isolation

```sh
npm run lint
npm run build
npm run check:tv-isolation
npm run test:e2e
npm run test:e2e:keyboard
npm run test:e2e:tv
DEN_TV_PLATFORM=tizen npm run test:e2e:tv
npm run test:e2e:tv-package
DEN_TV_TEST_ENGINE=webkit npm run test:e2e:tv
npm run test:e2e:tv-soak
DEN_TV_PLAYBACK_SOAK=1 npm run test:e2e:tv -- tv-playback.spec.mjs --grep @soak
DEN_TV_LIBRARY_STRESS_200=1 npm run test:e2e:tv -- tv-library-stress.spec.mjs
node scripts/test-tv-core.mjs
node scripts/test-tv-chromium87.mjs
DEN_TV_LIBRARY_STRESS_200=1 node scripts/test-tv-chromium87.mjs
npm run build:tv:webos
npm run build:tv:tizen
node scripts/tv-package.integration.mjs
node scripts/tizen-package.integration.mjs
npm run test:tv-preflight
```

Playwright needs its Chromium/WebKit browsers installed. TV E2E runs the production
bundle, exercises real encrypted-library Workers and pairing, and the HLS tests play checked-in
media segments (not mocked `play()` or `currentTime`). Separate AVPlay tests use an explicit
workstation SDK fixture: they verify bridge state/transport, caption rendering, error redaction,
cleanup, and the actual packaged script/CSP path, not Samsung decoding. Backend responses are fixtures;
these tests do not use or modify the live library. They also cover remote navigation,
focus restoration, repeated detail/Back cycles, remote source/audio/subtitle selection,
resume, Next, retry after a failed session, visibility cleanup and Back during loading.
The compatibility journey removes newer APIs in both page and Worker globals;
it is not an emulator of an older Chromium engine. Native WebKit HLS evidence is
not LG decoder evidence.

The optional Chromium 87 runner uses the real official Linux x64 snapshot
`812859` (`87.0.4280.0`), verifies the pinned archive SHA-256 and engine version,
then executes the production build in an amd64 Docker container with networking
disabled. Docker, curl and unzip are prerequisites; image preparation/downloads
need internet, but the browser only reaches local fixture endpoints. The build
context contains only the Dockerfile. Only generated assets, E2E fixtures,
Playwright and an empty browser profile enter the runtime—not workspace secrets,
personal profiles or live libraries. Evidence persists in
`web/test-results-tv/chromium87-<port>-<suffix>/`; scratch builds are removed.
This exercises startup, encrypted pairing/save/reload, Search, detail/Back,
Settings, diagnostics and retained Home navigation. It is old-engine evidence,
not LG firmware or decoder qualification.
The optional saved-library flag also runs the 200-title journey in this actual
engine. Its test timeout bounds the workstation fixture; it is not a TV timing SLA.
The 2026-10-18 actual-engine run passed all 23 selected journeys with this flag,
including encrypted 200-title persistence and 200 Home/detail/Back visits. After
forty warm-up visits it retained 4,274 DOM nodes, 138 listeners and about 8.7 MB
post-GC heap; at 200 visits it retained 4,299 nodes, 139 listeners and about 8.7 MB,
with two route surfaces and one Worker throughout. The TV core's clean-room
regeneration also reproduced every checked-in artifact byte for byte, and all
242 shared policy vectors agreed with the unchanged browser core.

The browser build rejects any TV/core-js module in its output graph, including lazy
chunks. A checked-in clean-main baseline also gates compressed initial/all JS+CSS
growth and checks TV-only markers. Run `npm run check:tv-isolation` for exact current
compressed deltas against `3fccf42`. `node scripts/tv-browser-performance.mjs`
alternates fresh browser contexts between `dist-browser-baseline` and `dist`,
with deterministic local fixtures, reporting paint timing and resource transfers.
Successive pairs reverse execution order, and the report records bundle fingerprints,
readiness medians/ranges and uncaught-page-error checks. Set `DEN_BROWSER_PERF_RUNS=6`
for six balanced pairs. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects an installed
Chrome when Playwright's bundled browser is unavailable.
Set `DEN_BROWSER_PERF_ENGINE=webkit` for the same comparison in WebKit. It also measures
detail, Back, Settings, a retained-library return and the idle preload window. These
fresh contexts use HTTP no-store; the return is not a service-worker cache benchmark.
Layout-shift sums and long-task observations are supplementary diagnostics, not a
complete CLS/INP/Core Web Vitals assessment. Unsupported engine metrics are null.
Workstation timings are not TV hardware measurements. TV builds target Chrome 85, have isolated
output directories, and verify Worker compilation and compatibility imports. Only
E2E builds include the Player harness; normal TV builds omit it.
Packaged URL helper calls in shared code must stay behind `__DEN_TV_PACKAGED__`;
the browser module gate rejects that helper too, preventing an extra browser
request merely to preserve the browser's existing path behavior. CI retains browser and TV
failure traces and screenshots for seven days.

After merging current main, the 2026-10-19 final isolation check against a clean
`f1ca06b` build measured **+1,545 bytes initial gzip and +4,560 bytes total gzip**.
The branch has 84 browser JS/CSS assets versus main's 82; directional navigation
remains an optional chunk rather than entering the initial preload graph. No TV
module is present in the browser output.
The baseline was rebuilt from that exact main commit using the same toolchain;
the byte-budget ceilings were not increased.
Six fresh counterbalanced pairs per engine found no reproducible slowdown. The
final build kept the same request count as the baseline (41 initial/91 through
idle in Chromium, 42 initial/91 through idle in WebKit) and transferred 1,847
additional uncompressed bytes initially and 2,323 through idle. Timing samples
had overlapping ranges and mixed directions; for example baseline/current entry
medians were 69/69 ms in Chromium and 80/82 ms in WebKit. These do not establish
a speedup. The reports retain every sample and both bundle fingerprints (current
`44225ff22707baf512b221b8f899fc6f00f825e02a19384462eca7154876aabd`).
Use six counterbalanced pairs against that baseline in each engine and run the comparison
after local test suites finish. Record the generated report and its fingerprints with
the PR's validation evidence; overlapping variable samples do not establish a hardware
speedup or a stable timing regression.
The script labels initial-navigation paint metrics separately from interaction
readiness; resource snapshots are taken at those milestones, not after all idle
preloads. It requires the clean-base output in `web/dist-browser-baseline` and the
current browser output in `web/dist`. An attached DevTools-profile audit was not
run because that existing browser profile was in use; the comparison used isolated
Playwright contexts without interrupting it.

Before claiming device support, record an actual C2/C4 firmware run: linking and
relaunch, Magic Remote/D-pad and on-screen keyboard, Back/exit, a representative
codec/audio/subtitle/source/resume matrix, suspend/reopen, and a longer browsing
and playback soak. Samsung additionally needs installed-widget assets/API validation,
real SDK key/exit behavior, AVPlay decoder/track evaluation and a signed package. These are remaining
qualification tasks, not reasons to block the local preview.

Focus restoration keys include the originating shelf, so duplicate titles in
different shelves remain distinct. The existing bounded route cache is reused (two inactive details),
not replaced with a separate TV router.
Restoring focus no longer scrolls an already-visible poster after the router has
restored the document offset. The full WebKit stress journey exposed a 12px move
caused by aligning the card's trailing metadata instead of its poster. The TV
restore path checks the poster surface and horizontal shelf bounds; genuinely
offscreen controls still receive scroll-into-view handling. This is separate from
directional navigation, which keeps its intentional scrolling behavior.
TV builds omit touch-only page snapshots and limit Home's idle screen warm-up to
Details. Search, People, Settings and Player load on intent; browser preload policy
and touch behavior stay unchanged.

TV billboard arrows select and focus the adjacent title immediately, independently
of touch-scroll settling. In a controlled two-arrow comparison of production outputs,
key dispatch through visible-title/focused-action assertions took 778–781 ms before
the change and 10–15 ms after it. Suppressing `scrollend` listeners before startup
exposed the old one-second fallback (1015–1035 ms); the new path took 19–35 ms.
These are small workstation diagnostic samples, not TV latency guarantees. The
older target engines predate [Chromium's `scrollend` support](https://developer.chrome.com/blog/scrollend-a-new-javascript-event).
Chromium 87 also lacks native `inert`: Svelte's property assignment did not create
an attribute there. The arrow path therefore selects the current action by its
explicit `tabindex="0"`, not by an absent `inert` attribute. Actual-engine tests
reproduced the previous-slide focus error and verify the corrected route.
The normal browsing resource check runs 200 detail/Back cycles in Chromium and forty
in WebKit across three titles, both arrow directions, retained-page bounds and Worker
counts, without retrying missed presses. Chromium additionally samples DOM nodes,
event listeners and post-GC JavaScript heap after warm-up and at completion.
`npm run test:e2e:tv-soak` extends this same real remote journey to thirty minutes;
set `DEN_TV_SOAK_MINUTES` for another duration (up to four hours). Samples follow a
two-second idle interval and are saved incrementally as `tv-browsing-soak.json` in
the run's Playwright output directory, including when a later assertion fails.
`DEN_TV_SOAK_HEAP=1` additionally saves warm/final Chromium heap snapshots. Traces
and video are disabled for this resource experiment; failures still save screenshots.
These are workstation, post-GC page measurements, not natural-GC pauses, decoder/GPU
memory, or a guarantee of leak freedom. WebKit does not expose these CDP counters.

The 2026-10-18 thirty-minute Chromium run completed 4,431 detail/Back visits.
After warm-up it measured 4,146 DOM nodes and 132 listeners; the final sample had
4,191 nodes, 133 listeners and about 12.5 MB JavaScript heap. That run included the
retained loading-poster and restoration fixes, before the later old-engine
compatibility work; it is not a thirty-minute run of the final artifact. The
ordinary bounded-resource journey is rerun against the final production output.

The opt-in playback soak uses the checked-in fMP4 fixture with explicit HLS
discontinuities and modest deterministic segment delay. It runs media at normal
wall-clock speed, requires a single session throughout, and checks progress/end
cleanup on remote Back. It does not mock `play()` or advance media clocks.
Full ten-minute runs passed in Chromium and WebKit on 2026-10-18: respectively
601 seconds of media over 601/603 seconds wall time, one session and one end
request each, and no uncaught page errors. Their source snapshot includes the
native expiry check, before the final in-flight-probe cancellation guard; that guard has a
separate held-response lifecycle regression. The test saves engine/version,
elapsed time, persisted media position, session/end counts and errors as JSON evidence.
An extended native WebKit expiry probe found that a segment HTTP 410 first drains
the buffer, then eventually surfaces as a decode error. Previously Den discarded
the authoritative 410 response and entered decode recovery. The shared player now
classifies that response as an expired session once a media error arrives;
playlist-level 410 responses are preserved too. For native TV playback, the existing
stall observer also checks for an authoritative 410, without waiting indefinitely
for a media error. This check is TV-only and ignores ambiguous replies.
A real loopback HTTP media server proves native WebKit expiry/Resume into a fresh
session; a deliberate pause remains paused. Chromium/hls.js also verifies backward
and explicit-zero resume positions. Native media requests are not intercepted in
the WebKit expiry case. This establishes workstation behavior, not LG decoder
qualification or a firmware-independent recovery deadline.

The dense Search fixture contains 72 results. The separate saved-library journey
creates 24 actual encrypted library entries through production Watchlist controls;
`DEN_TV_LIBRARY_STRESS_200=1` enables the larger 200-title case. Both verify deep-grid
remote navigation and detail/Back restoration; Search also checks long-title bounds.
The Watchlist grid currently mounts every saved card. The optional case records its
DOM/card counts and focus-handling samples, without a machine-sensitive timing gate.
The dense Search journey also records native keydown-to-focusin timing. Across 17
transitions per run, workstation medians/p95 were 1.1/3.5 ms for the LG-targeted
Chromium build, 1.0/2.3 ms for the Samsung-targeted Chromium build and 1.0/1.0 ms
for WebKit. These measure focus handling, not painted-highlight latency on a TV;
the test reports timings without imposing a CPU-sensitive CI timing threshold.

## Follow-up audit

Season tabs now retain their own left/right selection behavior. Watchlist actions are
visible without hover, Sources has a direct Down/Up path between its disclosure and
first source action, and pairing preserves focus as a code becomes an approval prompt.
Source metadata is enlarged for viewing distance and season focus rings stay inside
their scrollable strip instead of being clipped.
Hardware Back leaves a Settings editor before closing its row. Production E2E exercises
each of these flows, including encrypted two-device pairing and relaunch persistence.
Remote handling is installed before downloading the main application chunk, keeping
hardware Back/exit available on the starting screen. A held-chunk regression proves
this without depending on the download completing first.
Missing-screen recovery is fault-injected against the compiled application: one fresh
document can load a replacement asset graph, while a persistent failure exposes Retry
without a reload loop. Opt-in diagnostics also work from the startup-failure surface.

Linux WebKit CI exposed an arrow press lost immediately after Back. Holding and then
releasing the browser's restoration frame reproduced the old rail position overwriting
the newly selected slide. TV input now cancels that pending restoration; the regression
journey exercises this exact ordering without retrying presses. Browser restoration is unchanged.
The no-trace resource run exposed an earlier ordering too: input could arrive after
the navigation observer restored focus but before the initial post-flush restoration.
TV cancellation now begins before that flush, and separate E2E variants cover both
the first-restored-focus and delayed-frame boundaries.

The extended resource check also caught detached loading-poster trees retained via
Chromium's responsive-image viewport listeners. The TV loading shell now uses a fixed
342px poster URL; the resolved detail and ordinary browser retain responsive images.
The controlled short run changed from roughly eleven retained nodes per visit to a
flat post-GC count (4,115 nodes at both forty and 280 visits). This does not substitute
for a device memory soak. Diagnostics also catch synchronous IndexedDB write refusal
inside their callback, so the check reports failure without an uncaught storage error
and can be retried after storage becomes available.

Samsung AVPlay opens relative playback URLs at the configured API origin, waits for
resume seeking before Play, and fences callbacks after teardown. SDK error details can
contain signed URLs: only recognized platform error enums reach diagnostics/reports.
External WebVTT uses browser cue parsing and an overlay synchronized to the AVPlay clock.
The five AVPlay journeys and the packaged bridge journey use an explicitly mocked SDK;
the separate HLS journeys exercise actual media decoding.

TV posters now open Details directly, without separate action-menu stops in the
remote focus path. A production E2E journey verifies that neither a visible
trigger nor a keyboard context-menu action opens a poster menu, then opens Details
and restores the original result on Back. Other TV menus retain their native-dialog
fallback for old engines; browser builds keep native popovers.

A repeated hardware Back event before player unmount previously called the parent
close callback twice. Closing is now idempotent, and the real HLS journey checks
the repeated-event case and track-picker cancellation. Search also no longer
allocates a duplicate TV query state or an empty effect in the browser build;
its route query is the single source of truth.

The package suite includes a distinct third-origin media CDN: a grant-bearing
playback request reaches Den's API, actual HLS playlist/init/media segments play
from the CDN without Den or Authorization headers, and end/heartbeat/report
controls stay on the API. It checks time advancement, CSP violations and page
errors. Dynamic HTTPS media/addon access remains intentional; executable code
is still restricted to the package.

`npm audit` currently reports eight high findings, all in the existing
development-only Stylelint chain (`stylelint`/`stylelint-config-*` →
`globby`/`fast-glob`/`micromatch`/`braces`). The TV change only adds `core-js`,
which introduces no audit finding. The [upstream advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
lists no patched version. npm's force-fix suggestion downgrades the Stylelint config
to an incompatible major; it is not a safe dependency upgrade. The existing CI audit
exception is development-only and expires on 2026-11-02; it was not broadened or renewed.
