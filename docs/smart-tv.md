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
Workers, IndexedDB and WebAssembly. The shipped Rust/WASM glue uses
`WebAssembly.instantiateStreaming` with an `instantiate` fallback and an
`externref` table; reference types predate the Chrome 85 baseline, but the
actual `.wasm` must still be loaded on each TV because firmware engines can
diverge.

## Samsung Tizen

The generator currently stops before producing a `.wgt` and exits nonzero. A
bundled client still needs validation of Vite base-relative assets, path-based
SPA routing, media APIs, and signing. It does not claim that arbitrary remote
content is an approved Samsung hosted app: Samsung says hosted/cloud apps are
normally not accepted without Content Manager approval, and Tizen APIs are not
available in hosted apps. A signed `.wgt` also requires Tizen Studio and a
configured certificate profile. It never installs.

References: [Samsung hosted applications Q&A](https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html),
[web app configuration and privileges](https://developer.samsung.com/smarttv/develop/guides/fundamentals/configuring-tv-applications.html?device=htv),
[Tizen CLI packaging](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html?device=htv),
[testing on a TV](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).

The working Samsung target should be recorded as an explicit model/firmware
and browser baseline (the current project target uses Chrome 85 as a minimum
planning assumption). Confirm actual feature support on hardware; a package
build or browser E2E run is not hardware proof.

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

The reference inspected was `den/App/Den/Components/FeaturedHero.swift` and
`Screens/DetailView.swift`, not the hero's stale introductory comment. Its current
hero has one **Details** button. The shared TV billboard keeps one **More** link
to the detail page, with a noninteractive title; browser-only Watchlist/Seen,
pagination dots and the fullscreen shortcut are removed from the TV hero.
Watchlist/Seen and the available playback/source/trailer actions remain on the
shared detail screen. The normal browser presentation is unchanged.

This is not full native-tvOS parity. Native downloads, platform player menus and
codec/HDR behavior do not become available merely by reusing a screen. TV playback
reuses the existing source/session, retry and progress logic, with remote
play/pause/seek, a hideable controls overlay, and Back/visibility cleanup. LG's
webOS user agent explicitly selects native HLS. Desktop preview uses native HLS
where available and hls.js otherwise; Samsung has no AVPlay adapter yet.

## Verification and browser isolation

```sh
npm run lint
npm run build
npm run check:tv-isolation
npm run test:e2e
npm run test:e2e:tv
DEN_TV_PLATFORM=tizen npm run test:e2e:tv
DEN_TV_TEST_ENGINE=webkit npm run test:e2e:tv -- tv-playback.spec.mjs
npm run build:tv:webos
npm run build:tv:tizen
node scripts/tv-package.integration.mjs
```

Playwright needs its Chromium/WebKit browsers installed. TV E2E runs the production
bundle, exercises real encrypted-library Workers and pairing, and plays checked-in
HLS segments (not mocked `play()` or `currentTime`). Backend responses are fixtures;
these tests do not use or modify the live library. They also cover remote navigation,
focus restoration, repeated detail/Back cycles and Back during session loading.
The compatibility journey removes newer APIs in both page and Worker globals;
it is not an emulator of an older Chromium engine. Native WebKit HLS evidence is
not LG decoder evidence.

The browser build rejects any TV/core-js module in its output graph, including lazy
chunks. A checked-in clean-main baseline also gates compressed initial/all JS+CSS
growth and checks TV-only markers. The initial implementation measured +42 bytes
initial and +77 bytes total gzip against `a045b842`; byte isolation is not a claim
that hardware timings have been measured. TV builds target Chrome 85, have isolated
output directories, and verify Worker compilation and compatibility imports. Only
E2E builds include the Player harness; normal TV builds omit it.

Before claiming device support, record an actual C2/C4 firmware run: linking and
relaunch, Magic Remote/D-pad and on-screen keyboard, Back/exit, a representative
codec/audio/subtitle/source/resume matrix, suspend/reopen, and a longer browsing
and playback soak. Samsung additionally needs bundled routing/assets/API validation,
key registration, AVPlay evaluation and a signed package. These are remaining
qualification tasks, not reasons to block the local preview.

One known focus limitation: a title repeated in multiple shelves currently shares
its restoration key, so returning may focus the first visible occurrence of that
title rather than its original shelf. Ordinary unique-title and hero restoration
are covered. The existing bounded route cache is reused (two inactive details),
not replaced with a separate TV router.

`npm audit` currently reports eight high findings, all in the existing
development-only Stylelint chain (`stylelint`/`stylelint-config-*` →
`globby`/`fast-glob`/`micromatch`/`braces`). The TV change only adds `core-js`,
which introduces no audit finding. Resolving the audit requires a major
Stylelint-config upgrade and is deliberately outside TV packaging scope.
