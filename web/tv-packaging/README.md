# TV packaging templates

The Android TV launcher lives in `../../android-tv`: it is a small native WebView shell around the same hosted TV
bundle as LG. It appends `DenAndroidTV/<version>` to its user agent, which lets the shared bundle label the device
and route root Back to the native activity without exposing an Android JavaScript interface to third-party frames.
CI tests, builds and lints the shell. The intentional `tv-android-publish` workflow signs its APK with the
repository's stable Android signing key, verifies the pinned certificate fingerprint, and publishes a versioned
release; ordinary Den Edge releases do not rebuild the hosted-UI shell.

`scripts/tv-package.mjs webos --url https://your-tv-host/` writes a hosted LG
launcher into `tv-packages/webos/shell` and invokes LG's `ares-package` to put
the `.ipk` in its sibling `packages` directory. It never modifies `dist-tv-*`.
The checked-in 80×80 and 130×130 icons are rendered from `public/favicon.svg`
by `node scripts/tv-icons.mjs`.

The generated app is a remote-content shell. It contains no credentials and
never installs or deploys to a device.
The LG shell uses `disableBackHistoryAPI: true`; its redirect page recognizes
the documented Magic Remote back key code (`461`) while the hosted TV bundle
owns route Back and root exit through the webOS bridge. `requiredACG: []` is
emitted because this launcher does not call Luna services.

Once the preview and its HTTPS hostname are reachable, run the read-only readiness
check before opening it on a TV, with a representative playlist:

```sh
DEN_TV_HOST=tv.example.com \
DEN_EDGE=http://your-den-edge:8094 \
DEN_TV_MEDIA_URL=https://cdn.example/media/master.m3u8 \
npm run preflight:tv
```

The check validates a non-loopback HTTPS TV hostname, probes `/health` on the
configured edge/API origin, checks the TV origin's CORS response when it is
advertised, and fetches only the beginning of the HLS playlist. It prints
origins and redacted targets only; query strings, paths, and credentials never
appear in output. It does not start a backend, tunnel, preview server, or SDK.

## Bundled Tizen package (explicitly opt-in)

All three platforms are released intentionally and independently. Bump `tv-packaging/tizen/VERSION` and dispatch
`tv-samsung-publish` when a tested TV UI change should reach Samsung. For a native Android change, bump
`android-tv/VERSION` and dispatch `tv-android-publish`; for an LG launcher change, bump
`tv-packaging/webos/VERSION` and dispatch `tv-webos-publish`. Each workflow rejects a version that does not exceed
the newest published version, creates a draft with every artifact and checksum, verifies the uploaded copies, and
only then publishes its immutable `tv-<platform>-vX.Y.Z` release. No workflow force-moves a release tag or replaces
assets in place.

Build the actual local bundle with an API origin, then package it with a named
Tizen Certificate Profile:

```sh
DEN_TV_PACKAGED=1 DEN_TV_API_ORIGIN=https://d-api.example DEN_TV_SERVICE_ORIGIN=https://d.example npm run build:tv:tizen
DEN_TV_API_ORIGIN=https://d-api.example DEN_TV_SERVICE_ORIGIN=https://d.example node scripts/tv-package.mjs tizen \
  --url https://d-api.example --profile MyCertificateProfile
```

Without a Tizen SDK/profile, inspect the unsigned shell instead:

```sh
DEN_TV_API_ORIGIN=https://d-api.example DEN_TV_SERVICE_ORIGIN=https://d.example node scripts/tv-package.mjs tizen \
  --url https://d-api.example --prepare
```

`node scripts/tizen-package.integration.mjs` builds the packaged bundle and
runs this shell-only validation (including optional `xmllint` XML validation).

The build writes `web/dist-tv-tizen-package`; packaging copies that bundle into
`web/tv-packages/tizen/shell`. The API setting must be an exact HTTPS origin—no
path, query, fragment, or embedded credentials—and test-fixture builds are refused.
The publisher generates separate manifests requiring Tizen 8.0 (Chromium 108), Tizen 6.5 (Chromium 85), and Tizen
5.5 (Chromium 69). All
declare the Samsung TV profile/API level, Internet and TV input-device privileges, and wildcard WARP access because media CDNs and
user-installed addons are not known when the widget is signed. A CSP separately
keeps executable scripts, styles, and workers inside the signed widget while allowing
HTTPS media, images, frames, and connections. API credentials remain governed by the
runtime's Den-path allowlist; WARP does not grant credentials to external origins.
The Tizen 8 package uses the narrower `wasm-unsafe-eval` source. The separate Tizen 6.5 and 5.5 packages use the
broader `unsafe-eval` required by those older engines and are intended for Apps2Samsung sideloading, not Seller
Office submission. The 5.5 build additionally targets Chromium 69, converts owned module Workers to classic Workers,
and includes TV-only standard-library fallbacks. CI verifies all package variants, but old-generation hardware
remains unqualified until it is tested on a real TV. The same per-version policy is embedded in packaged HTML so
production package E2E exercises it rather than testing a more permissive page.
The packaged Vite build includes Samsung's required
`$WEBAPIS/webapis/webapis.js` bridge in the entry HTML before the app module;
the packager validates that exact bridge instead of injecting a divergent copy.
It is present only in packaged output: browser previews do not request the
device bridge. The CSP's narrowly widened `object-src 'self'` permits the
platform-owned AVPlay object while still refusing remote objects.
Standard AVPlay does not use the obsolete `http://developer.samsung.com/privilege/avplay`
privilege; add a narrower product privilege only if a future protected-media
feature specifically requires it.
The signer command is never run unless
`--profile` is explicit. Missing Tizen CLI, certificate profile, or a failed
signing step exits nonzero and leaves only the shell for inspection. This is
not a claim of device compatibility until production E2E and hardware checks
pass.

The bundled icon is the local 117×117 development icon used by Tizen Studio. Samsung's Seller Office
publication artwork (1920×1080 and 512×423) is uploaded separately and is not
generated by this repository.

See [local setup and testing](../../docs/smart-tv.md).

## Readiness and SDK smoke checks

The non-deploying integration checks are deterministic and use local fixtures:

```sh
npm run test:tv-preflight
node scripts/tv-package.integration.mjs
node scripts/tizen-package.integration.mjs
```

The LG smoke check verifies the hosted redirect, launcher metadata, 80×80 and
130×130 icons, and the current `requiredACG: []` requirement. The Samsung check
verifies the Tizen manifest, CSP, relative assets, icon, and Web API bridge;
when the SDK is unavailable it leaves only an unsigned inspection shell. A real
TV is still required to prove the webOS bridge's `platformBack` behavior,
Samsung's `tizen`/`webapis` objects, AVPlay state transitions, codecs, TLS trust,
DNS/routing, suspend/relaunch, and signed-package installation.

Official references: [LG hosted web apps](https://webostv.developer.lge.com/develop/getting-started/web-app-types),
[LG appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json),
[LG Back Button](https://webostv.developer.lge.com/develop/guides/back-button),
[Samsung web application configuration](https://developer.samsung.com/smarttv/develop/guides/fundamentals/configuring-tv-applications.html?device=htv),
[Samsung AVPlay](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html),
and [Samsung hosted applications](https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html?device=htv).
