# Den Edge web: completed delivery and follow-up notes

Updated 12 September 2026 after deployment and final measurements. The user requested durable takeover documentation because the conversation was running low on tokens. **The requested release, cleanup, audit, deployment, and report are complete. Do not restart the audit or repeat pairing.**

## Delivered state

- **[v0.50.1](https://github.com/oxyc/den-edge/releases/tag/v0.50.1) is published and deployed.** Tag commit: `e081b1f78e773c58e8136205dd6e42b555aa7c96`.
- [Release workflow 34713958173](https://github.com/oxyc/den-edge/actions/runs/34713958173) succeeded, including full CI, image scan, and signing.
- Deployed image: `ghcr.io/oxyc/den-edge@sha256:762e28dfddaca7745da2b058a32dd34c1d048c13507aece1df0ca529bafd5ee0`.
- `den-update` verified the signature, proved the replacement, restarted the service, and confirmed it serving. Live `/version` = `0.50.1`, `/health` = `ok`; verified around 19:29 UTC on 12 September.
- Final findings, measurements, improvements, limitations, and suggestions: [PERFORMANCE_AUDIT.md](PERFORMANCE_AUDIT.md). No pending deployment or report measurement remains.

## Commits and validation

- v0.50.0 feature release, previously deployed: `da3c475cc3aa7f39ddf20d983e6690a1dfdfc15e`.
- Prettier, ESLint, Stylelint, CSS cleanup, CI enforcement: `4499b676259629d9d8476f90a2bc73578d0cd418`.
- Performance, stable shelf loading, sync byte budget, ETags/CSP: `69172bdc433a0c3bcf810313607dda708c1a81ef`.
- Actor-test readiness and installed-browser fallback: `e081b1f78e773c58e8136205dd6e42b555aa7c96` (v0.50.1).
- Initial durable report/handoff: `660cc71`; later documentation commits finalize the observed deployment results.
- Release CI: **65 Rust tests, 252 web unit tests, all 46 browser tests**, Clippy, rustfmt, Prettier/ESLint/Stylelint/Svelte/TypeScript, dependency audit, WASM/CSP smoke, build/compression checks, image scan, and signing passed.
- Corrected actor tests also passed **30 repeated local runs**. The older CI failure `34713461270` was a test readiness race: Filmography's heading exists before its cards load, and bottom scrolling starts additional pagination. The test now waits for actual cards, pagination, and View Transitions. Strict snapshot pixel comparisons remain; no retries/tolerance masking was added. Central router/snapshot code was not changed in this performance pass.

## Final measurements

Authenticated mobile emulation: 393×852 at 3× device scale, **4× CPU slowdown, Slow 4G**. Pairing and TMDB IndexedDB cache preserved; reloads used warm HTTP/image caches. These are individual lab runs, not physical iPhone or field guarantees.

| Scenario                             |     FCP |      LCP |   CLS |
| ------------------------------------ | ------: | -------: | ----: |
| Original Vite preview                | 5.524 s | 13.157 s | 0.362 |
| Final Vite preview                   | 5.556 s |  9.855 s | 0.000 |
| Production bundles, old backend      | 0.864 s |  7.214 s | 0.000 |
| Production bundles, deployed backend | 1.240 s |  5.320 s | 0.000 |

- Initial library sync: **five requests → one**, 367,957 bytes in 2.621 s under Slow 4G.
- Populated built-preview Lighthouse: **100 accessibility, 100 best practices**, SEO 83 due to Vite's HTML fallback for missing robots.txt.
- Actual deployed unpaired entry Lighthouse: **100 accessibility, 100 best practices, 100 SEO; zero failed audits**. Unpaired startup did not download WASM or HLS. This is a different screen from authenticated Home.
- The Lighthouse tool excludes performance scores. FCP/LCP/CLS came from Performance traces and Paint Timing. No field INP/CrUX data were available.
- Live HTTPS: matching conditional GET and HEAD give 304, hashed JS is gzip/immutable, `/health` is `no-store`, missing robots.txt is non-cacheable 404, CSP includes `object-src 'none'` and restricted WASM support.

## Workspace and operating instructions

- Actual repo: `/Users/cindy/Projects/Personal/den-edge`, branch `main`. The originally open workspace `/Users/cindy/Projects/Personal/den` is the separate native app.
- User authorized **commit, push, tag, release, deploy**, followed by formatting/lint/performance/header fixes. User strongly dislikes repetitive approval prompts. Reuse approved plain command prefixes; do not keep adding environment assignments before npm commands.
- Plain `npm run test:e2e` now reuses installed macOS Chrome if Playwright's bundled browser is absent. CI installs its pinned Chromium. Explicit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` still wins when needed.
- Sibling repo writes were authorized through patches created in the native workspace's `.formatting-work/`, applied with `git -C ../den-edge apply /Users/cindy/Projects/Personal/den/.formatting-work/NAME.patch`. Open `den-edge` as the workspace for future work to avoid this boundary. Do not bypass sandbox restrictions or commit native scratch files.
- Another agent may be working elsewhere. Do not reset unrelated changes or kill preview servers. No subagents were used during this audit.
- From `den-edge/web`: `npm run lint`, `npm test`, `npm run test:e2e`, `node test/sync-policy-browser.mjs`, `npm run build`.
- Rust: `cargo test --locked`; CI provides Clippy/rustfmt. Locally cargo-fmt was missing, but `/nix/store/l7xlkqk1bz4w75rwf5dh7pn2br04n59l-rustfmt-1.97.1/bin/rustfmt --check src/web.rs src/library.rs` worked.

Future deployment uses the established signature/probe/rollback procedure, after the relevant release workflow succeeds:

```sh
ssh root@pve incus exec den -- env TUF_ROOT=/var/lib/den/sigstore /usr/local/bin/den-update den-edge
ssh root@pve incus exec den -- curl -fsS http://127.0.0.1:8094/version
ssh root@pve incus exec den -- curl -fsS http://127.0.0.1:8094/health
```

The release already exists; do not repeat publication or move the v0.50.1 tag. Its release ID is `387680340`. Production HTTPS origin: `https://pve.tailce93d3.ts.net:8443/`. Do not read or print runtime environment secrets. For conditional-request checks compare the same negotiated encoding; this proxy can request gzip upstream for GET even when curl omitted Accept-Encoding.

## Browser context — preserve pairing

- Chrome DevTools MCP tools are dynamically available as `mcp__chrome_devtools__*`. The `web-perf` skill was applied: `/Users/cindy/.codex/skills/web-perf/SKILL.md`.
- Page **4** remains paired to the user's library as “Den performance audit”, in the default browser context, at the original `https://oskars-macbook-pro.tailce93d3.ts.net:8443/#library`.
- Viewport is still mobile 393×852×3, but **CPU/network throttling was disabled after the audit**. No trace is running. Reapply 4×/Slow 4G explicitly for comparable measurements.
- Normal preview is Vite + HMR on port 5173 behind Tailscale 8443. Do not replace this server globally.
- `npm run build`, then `/__build/#library` on that same secure origin, serves production bundles using existing API proxies and pairing. `/` remains development/HMR. This measures built frontend assets, not Rust's HTTP policy; inspect production headers separately.
- Page 3 is an unpaired production page in isolated context `den-performance-audit`. Page 2, `http://127.0.0.1:5197/test/router.html`, belongs to another audit context; leave it alone.
- **Do not clear storage/cookies/IndexedDB or request a new pairing code.** The previous code was already used. Never print storage or credentials.
- Private network URLs contain TMDB keys and encrypted addon configuration. Return aggregate timings/byte counts and sanitized paths only. For library timing, filter ResourceTiming by `/^\/lib\/[^/]+\/changes$/` and return start/duration/bytes, not the URL or request headers.
- Use manual traces (`reload:true, autoStop:false`) and stop after the real billboard and shelves appear. Automatic traces ended too early and measured the logo during initial investigation.
- Physical target is **Brave on iPhone 16 Pro**. Chromium emulation does not establish WebKit/native edge gesture or autoplay correctness.

## Follow-up opportunities, not unfinished release work

The report ranks further work: durable encrypted local log/cursor caching with reset/journal semantics; reproducible cold/warm fixture performance audits and physical iPhone checks; playback-specific HLS worker profiling; Brotli sidecars with full negotiation/validator tests; the remux service's exact preview-origin CORS policy. Keep subtitles/audio features and private API cache boundaries intact.

Implementation entry points: `web/src/Library.svelte` and `lib/libraryNaming.ts` (initial shelves); `components/Billboard.svelte` and `lib/tmdb.ts` (early high-priority backdrop); `PosterCard.svelte`/`BrowseRow.svelte` (stable geometry/contrast); `App.svelte` (paired preload/preconnect); `src/library.rs` (JSON page budgeting); `src/web.rs` (ETag/304/CSP); `web/scripts/previewBuild.ts` (development-only built preview); `web/e2e/library-loading.spec.mjs` and `actor-history.spec.mjs` (regressions).
