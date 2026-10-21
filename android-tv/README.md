# Den for Android TV

This is the small native launcher for the hosted Den TV app at `https://den-tv.oxy.fi/`. It deliberately does not
bundle the Svelte UI: Android and LG therefore receive ordinary TV UI changes without reinstalling their launcher,
while Samsung retains its separately bundled widget.

The activity supplies the Android TV launcher manifest, fullscreen custom views, remote Back translation, playback
screen-awake signaling, a native connection-error surface, and a stable user-agent suffix
(`DenAndroidTV/<version>`). The shared TV bundle recognizes that suffix to label the device and uses top-level
`den://` navigations for confirmed exit and playback state; the activity accepts only its closed set of private
commands. Do not replace it with `addJavascriptInterface`: Android exposes such interfaces to every frame, including
third-party trailer frames. `onStop` destroys the WebView so Android- and Amazon-provided WebViews release their
hardware decoder; returning recreates it and the hosted app resumes from persisted progress.

Foreign top-level pages and cleartext traffic are blocked. Subframes and resource requests remain available so Den's
existing trailers, addons, metadata, and signed media routes behave as they do in the hosted LG build.

## Build

Install JDK 17 and Android SDK Platform 36, then point `local.properties` at the SDK and run:

```sh
./gradlew :app:lintDebug :app:testDebugUnitTest :app:assembleDebug
```

The app version comes from `android-tv/VERSION`; `X.Y.Z` maps to version code `X000000 + Y000 + Z`, with each
component restricted to 0–999. Bump it only when publishing a changed native launcher. Override the hosted endpoint
only for a development build with
`-PdenTvUrl=https://tv.example.test/`.

A release build is signed only when all four variables are present:

```sh
DEN_ANDROID_KEYSTORE_FILE=/absolute/path/to/release.jks \
DEN_ANDROID_STORE_PASSWORD=... \
DEN_ANDROID_KEY_ALIAS=... \
DEN_ANDROID_KEY_PASSWORD=... \
./gradlew :app:assembleRelease
```

The manually dispatched `tv-android-publish` workflow reconstructs the keystore from the corresponding
`DEN_ANDROID_*` repository secrets, runs native tests, verifies the APK against the fingerprint pinned in
`SIGNING_CERT_SHA256`, and publishes an immutable `tv-android-vX.Y.Z` release only after downloading and checking its
uploaded artifact. Preserve that key: Android accepts an in-place update only when it has the same application ID
and signing identity as the installed build.
