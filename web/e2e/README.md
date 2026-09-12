# Navigation regressions

From `web/`:

```sh
npm ci
npx playwright install chromium
npm test
npm run check
npm run test:e2e
```

Playwright starts an isolated Vite server on port 5198. Fixtures use the real router and, where appropriate, real Library/Detail/Person components with mocked TMDB data; no pairing or personal credentials are needed. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` only to use an existing compatible Chromium installation.

Coverage includes nested Back/Forward, scroll and horizontal rails, search/form state, retained rows, repeated visits, reduced motion, missing View Transition support, rapid navigation, swipe cancellation/overlap, ghost clicks, interior versus carousel gestures, loading covers, the Home → movie 1 → Home → movie 2 wrong-snapshot regression, direct hash entries, independent snapshot DOM ownership, frozen animation geometry, movie → actor → Back, poster rendering, and delayed metadata/image layout stability. Unit tests cover gesture direction/ownership and cancellation during asynchronous landing.

Synthetic touch events exercise the app's handlers. They cannot reproduce native Brave/iPhone gesture arbitration, memory pressure, or rotation behavior; physical-device testing remains necessary.

Actor landing coverage independently delays filmography, completes it while the page is hidden, and compares frozen/live screenshots at the actual handoff. It repeats Forward in portrait and landscape, including a saved bottom scroll that must clamp after rotation. Branch tests verify exact movie IDs, and separate visits to one movie retain independent form/scroll state. Discarded history branches are released.

Billboard viewport tests keep the hero and following content fixed during height-only touch viewport changes, while checking that rotation and desktop resizing still respond. See [NAVIGATION_AUDIT.md](NAVIGATION_AUDIT.md) for reviewed behavior and remaining limitations.

Billboard loading tests delay metadata and artwork independently, check title/metadata/overview/action rectangles, and compare short/long-title slides. Desktop navbar coverage checks scoped Back, keyboard activation, direct-link fallback, the existing Den icon, and 320px/390px layouts.

Detail trailer tests play a generated, silent WebM through mocked byte-range responses. They check detail playback starting at zero seconds, muted single playback, mobile media above the details, desktop overlay layout, unchanged geometry after playback starts, pause/resume offscreen, missing/broken trailers, blocked autoplay, reduced motion changes, late resolution after leaving a route, and frozen video pixels in independently displayed swipe snapshots.

Mobile trailer regressions suppress compositor callbacks while real video plays and compare screenshot pixels for opaque letterboxing, both live and in a swipe snapshot. YouTube link tests cover the visible Trailer label, exact videos and search fallback, mobile handoff links, desktop new tabs, and the full action row at 320px.

Navbar search has its own retained SPA route. Tests cover mobile expansion and Cancel, direct-link fallback, immediate cancellation during a transition, keyboard focus, stale-query responses, and Home/result scroll restoration. Settings remains a text label at every width.

Mobile billboards open details by tapping the slide, with native horizontal swipe and independent pagination dots. Action buttons remain on desktop. Normal phone widths use one heading line; widths below 360px keep two. Delayed discovery must preserve the visible billboard and its selected slide.
