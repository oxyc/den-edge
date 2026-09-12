# Den web performance and stability audit

Date: 12 September 2026. Scope: the paired Home/library page, production assets, navigation regression coverage, CSP, HTTP caching, and maintainability.

The audit found real layout instability during initial library naming and excessive sequential sync requests. Both were fixed. The paired page now records **CLS 0.00** in the measured runs. Production bundles also avoid the long module-request waterfall of the Vite development server. These are controlled browser observations, not a claim of perfect behavior on every device.

## Measurements

The authenticated tests used the requested Tailscale preview, a 393 × 852 viewport at 3× device scale, Chrome's **4× CPU slowdown and Slow 4G** network preset. Browser pairing and TMDB's IndexedDB cache were preserved. Reload measurements below use warm HTTP/image caches unless stated otherwise; they still fetch the encrypted library from the server.

| Scenario                                      |                       FCP |                       LCP |                       CLS |
| --------------------------------------------- | ------------------------: | ------------------------: | ------------------------: |
| Original Vite preview, paired Home            |                   5.524 s |                  13.157 s |                     0.362 |
| Frontend fixes, Vite preview, old sync server |                         — |                  13.369 s |                     0.000 |
| Production bundles, old sync server           |                   0.864 s |                   7.214 s |                     0.000 |
| Production bundles, updated sync server       | Pending final measurement | Pending final measurement | Pending final measurement |

The production-bundle path is `/__build/#library` on the same preview origin. It serves the built files while sharing the existing API proxies and browser pairing. The normal `/#library` stays a Vite development preview. The production-bundle comparison demonstrates development-server overhead; it is **not** a before/after speedup attributable solely to the code changes. A first request of the new production bundle measured FCP 1.892 s, compared with 0.864 s on the cached reload.

The original unpaired production entry page measured LCP 237 ms and CLS 0.00 without throttling. That is a different screen and network condition, so it cannot stand in for authenticated library performance.

Lighthouse on the populated, fixed production-bundle preview scored **Accessibility 100, Best Practices 100, SEO 83**. The SEO failure is the development server returning its HTML fallback for missing `robots.txt`; production returns a proper missing-file response. The optional/nonstandard `llms.txt` audit is also affected by that fallback and is not an application performance requirement. No performance score is quoted: this Lighthouse integration excludes that category; FCP/LCP/CLS came from Chrome Performance traces and Paint Timing instead. No field INP/CrUX data are available for this private preview.

## Findings and implemented improvements

### Initial library layout

Continue Watching, Watchlist, and recommendation rows appeared at different times as title metadata arrived. Each new row pushed already visible content down. One follow-up diagnostic run reached CLS 0.519 before this cause was fixed.

The initial shelves now wait together for the metadata that determines their contents. Those lookups take priority over older watched history. The billboard can load during that work, and the existing spinner indicates shelf loading. Recommendation seeds are chosen by log recency before names are fetched, so network response order cannot replace the selected seeds. Older watched history enriches the page afterward. Failed initial shelf lookups are not immediately retried by background naming, which would reintroduce late insertion. Metadata network requests have a 15-second deadline.

Poster placeholders reserve artwork, its gap, and two text lines. Poster cards reserve the same metadata height whether a year is present or absent. An already remembered series still loads its episode shape when needed to determine Continue Watching correctly.

### Library sync

The server budgeted every string byte at the worst-case six-byte JSON escape cost. Ordinary encrypted base64 rows therefore filled a nominal 512 KiB page after approximately 85 KiB of actual response content. The measured library needed five sequential requests for about 360 KiB of response bodies.

The page budget now counts actual JSON string encoding costs while retaining the row limit, the byte limit, and conservative per-entry overhead. UTF-8, quotes, backslashes, short escapes, and other control characters are covered by tests. No library authentication, encryption, merge rules, or write limits changed.

### Images, loading, and bundles

- TMDB discovery results retain their already supplied backdrop path. The billboard requests that image before the full details request completes.
- The active billboard image has high fetch priority; neighboring images are warmed at low priority. Existing lazy poster loading remains in place.
- A newly inserted billboard rail no longer calls `scrollTo(0)` unnecessarily. The original trace attributed 84 ms of forced layout to this initialization; the production-bundle follow-up no longer flagged forced reflow.
- Paired sessions preconnect to TMDB's API and image origin. Unpaired screens no longer start the sync WASM download merely by mounting the app; library reads and actions retain their existing initialization/retry behavior.
- The app already loads HLS dynamically and uses native HLS when supported. The large HLS chunk is absent from the measured Home startup requests.
- Production assets retain verified gzip sidecars and long-lived caching for hashed filenames. The stylesheet's estimated render-blocking savings were zero in the measured warm traces, so it was not inlined.

The final build is approximately **97.8 kB gzip entry JavaScript**, **8.4 kB gzip CSS**, **86.5 kB gzip WASM**, and **179.0 kB gzip HLS** when playback requires it. The HLS chunk still triggers Vite's 500 kB uncompressed warning. Its deferred loading is verified; splitting the same library into arbitrary files would not reduce the amount needed for playback.

### HTTP caching and CSP

| Response or policy                | Result                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HTML and mutable static files     | `Cache-Control: no-cache` plus a content-derived ETag, allowing conditional 304 responses                       |
| Hashed build assets               | `public, max-age=31536000, immutable`, with ETags for explicit revalidation                                     |
| Compressed representations        | Distinct validators for gzip and identity; `Vary: Accept-Encoding` preserved                                    |
| Missing/unacceptable static files | `no-store`, avoiding persistent missing-asset responses across deploys                                          |
| Private API responses             | Continue to use `no-store`; no shared caching of library records                                                |
| CSP                               | Added explicit `object-src 'none'`; kept restricted script, frame, connection, and media origins                |
| WASM                              | `'wasm-unsafe-eval'` permits WASM initialization without permitting JavaScript `eval`                           |
| Styles                            | Inline styles remain permitted because dynamic layout, progress, and snapshot state use style attributes        |
| Existing hardening                | HSTS, nosniff, no-referrer, frame-ancestors, COOP/CORP, restricted permissions policy, and request IDs retained |

Tests cover GET and HEAD, wildcard and weak/list validators, stale validators after content changes, representation separation, retained response policy headers, gzip refusal/quality negotiation, and stale sidecar handling. The existing real-browser CSP smoke test still passes its positive WASM and negative-control checks.

### Accessibility and maintainability

Inactive billboard slides are inert and hidden from assistive technologies until selected. This also eliminates offscreen links being audited as broken skip links. Unavailable titles dim their artwork while keeping title/year text at readable contrast. The navigation search input now has a name, and the document has an application description.

Prettier, ESLint, Stylelint, and Svelte/TypeScript checks are installed and enforced in CI. Duplicate and competing CSS rules were consolidated, base styles precede state/media overrides, and intentional WebKit compatibility exceptions remain narrow and documented. Vendored/generated WASM assets are excluded from formatting. See `README.md` for the commands and CSS conventions.

## Validation

- Rust: 65 unit/integration tests passed locally, including JSON byte budgeting and conditional caching.
- Web: 252 unit tests passed.
- Full browser suite: 45 tests passed before the final unavailable-metadata case was added; all nine affected loading/billboard tests passed afterward. CI runs all 46 together.
- Existing browser coverage includes nested movie/actor Back and Forward, fresh navigation at the top, repeated visits with separate scroll positions, canceled/overlapping gestures, retained carousel positions, rotation, loading snapshots, trailer fallbacks, and detail feature parity.
- New browser coverage includes staggered initial metadata, delayed older watched history, unavailable metadata, poster-row geometry, and showing the high-priority backdrop before details resolve.
- Full lint: zero errors and warnings. Production build and compression round trips passed. Browser WASM/CSP, idle initialization, early-action single-flight, offline calls, and retry checks passed.
- Release CI, deployment, and final live header checks: to be recorded after deployment.

## Remaining suggestions and limits

1. **Reduce repeat full-library startup work.** The next likely improvement is a durable local encrypted log/cursor cache with generation/reset handling and existing journal semantics preserved. It must be designed and tested centrally; adding a general service-worker cache to private API traffic would be inappropriate. On cold metadata caches, a large watchlist still requires TMDB lookups before the initial shelves settle.
2. **Measure cold and real-phone behavior separately.** Add repeatable cold/warm production audits to CI with representative fixture library sizes, and periodically check Brave on the physical iPhone. Chrome's touch/CPU emulation does not reproduce WebKit's compositor, address bar, native edge gestures, autoplay policy, or thermal throttling. Automated navigation regressions pass; physical-device perfection has not been established.
3. **Investigate playback-specific main-thread work.** HLS currently runs without its worker. A dedicated playback trace can determine whether enabling the worker justifies a narrowly scoped CSP worker rule. Keep native HLS, subtitles, alternate audio, retry behavior, and autoplay fallback coverage. Do not switch to a reduced HLS build that removes required features just to silence the chunk warning.
4. **Consider Brotli after the main request-chain fix.** Gzip is already effective and cached. Prebuilt Brotli sidecars could further reduce cold transfer size, but require the same negotiation, variant-validator, freshness, and round-trip tests as gzip.
5. **Resolve the preview's remux CORS fallback at the service boundary.** The homelab remux health probe lacks an allow-origin response for this preview origin. Discovery catches the failure and tries the next route; it does not block Home. Review that service's exact origin allowlist or a same-origin preview proxy rather than allowing every origin.
6. **Treat SEO/tooling warnings in context.** This is a paired application. Missing crawler metadata on a development SPA fallback is separate from LCP, accessibility, CSP, and private data protection. A published landing page can have its own explicit indexing policy.

Reference material: [Chrome LCP diagnostics](https://developer.chrome.com/docs/performance/insights/lcp-breakdown), [layout shift guidance](https://web.dev/articles/optimize-cls), [HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching), and [CSP worker policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src).
