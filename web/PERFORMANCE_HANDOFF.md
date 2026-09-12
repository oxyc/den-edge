# Den Edge web: takeover notes

Updated 12 September 2026. Read this before resuming work. The user is running low on tokens and requested a durable handoff. **Do not restart the audit or repeat pairing.**

## Workspace and user instructions

- Actual repository: `/Users/cindy/Projects/Personal/den-edge`, branch `main`.
- The currently open workspace is `/Users/cindy/Projects/Personal/den`, a separate native-app repo. Scratch patches and the release JSON are in its `.formatting-work/` directory. Do not commit those scratch files to the native repo.
- User authorized **commit, push, tag, release, deploy**, then formatting/lint/performance/header fixes. That authorization persists.
- User is very frustrated by repeated approval prompts. Reuse approved plain command prefixes. In particular, use `npm run test:e2e` directly: the config now falls back to installed macOS Chrome if Playwright's bundled browser is missing. Prefixing each invocation with an environment assignment prevented reuse of the npm approval. CI still uses its installed pinned Chromium.
- Filesystem writes to the sibling `den-edge` repo require the sandbox's authorization. Existing approved patch workflow: create a unified diff in the writable native workspace, then `git -C ../den-edge apply /Users/cindy/Projects/Personal/den/.formatting-work/NAME.patch`. Opening `den-edge` as the workspace avoids that sibling-directory boundary. Do not bypass the sandbox.
- Another agent may be working elsewhere. Avoid resetting unrelated work or killing preview servers. No subagents were used during this audit.

## Completed and published work

1. **v0.50.0** released and deployed successfully earlier in this session. Feature commit `da3c475cc3aa7f39ddf20d983e6690a1dfdfc15e`. Release: <https://github.com/oxyc/den-edge/releases/tag/v0.50.0>. Docker workflow `34709186242` passed, including image scanning/signing. Live `/version` was verified as `0.50.0`; `/health` returned `ok`.
2. Formatting/lint cleanup committed and pushed as **`4499b676259629d9d8476f90a2bc73578d0cd418`**. Prettier + Svelte plugin, ESLint/TypeScript/Svelte rules, Stylelint, documented CSS conventions, all enforced in CI. That cleanup's CI passed. CSS duplicate/state/media ordering was cleaned up without globally disabling compatibility rules.
3. Performance/server fixes committed and pushed as **`69172bdc433a0c3bcf810313607dda708c1a81ef`**, package version **0.50.1**. See `PERFORMANCE_AUDIT.md` for findings, measurements, implementation details, and recommendations.
4. A pre-existing actor snapshot test race was exposed in CI and corrected in **`e081b1f78e773c58e8136205dd6e42b555aa7c96`**. The test had waited on the always-present Filmography heading instead of loaded cards/pagination. It now waits for actual cards, completed sentinel pagination, and View Transitions. The strict frozen/live pixel comparison remains. All **30 repeated actor scenarios passed** after this correction. Failure geometry is logged for future diagnosis.
5. **Tag `v0.50.1` has been created and pushed**, pointing to `e081b1f78e773c58e8136205dd6e42b555aa7c96`. Do not recreate or move it.

## Release status at handoff

**v0.50.1 has NOT yet been verified deployed.** The last verified live version remains v0.50.0.

- v0.50.1 release workflow: <https://github.com/oxyc/den-edge/actions/runs/34713958173> — in progress when these notes were written. It runs the full CI gate before publishing/scanning/signing the image.
- Main CI for the same commit: `34713955604` — in progress. A later documentation push may supersede/cancel this main CI run; the tag workflow is the release gate.
- Previous CI `34713461270` failed only the actor bottom-scroll/rotation screenshot test. Rust tests, Clippy, formatting, lint, unit tests, WASM/CSP, and the other 45 browser tests passed. **Do not mistake this older failure for the status of the corrected tag.**
- GitHub Release for v0.50.1 has not been created yet. Its prepared JSON is `/Users/cindy/Projects/Personal/den/.formatting-work/release-0.50.1.json`.

## Remaining steps, in order

1. Check the tag workflow:

   ```sh
   gh run view 34713958173 --repo oxyc/den-edge --json status,conclusion,jobs
   ```

   If it fails, inspect `gh run view 34713958173 --repo oxyc/den-edge --log-failed` and fix the actual failure. Do not deploy a failed image. Do not paper over pixel-test failures with retries or looser comparisons.

2. After the workflow succeeds, publish the prepared release:

   ```sh
   gh api repos/oxyc/den-edge/releases --method POST --input /Users/cindy/Projects/Personal/den/.formatting-work/release-0.50.1.json
   ```

   First check whether the release already exists if resuming after an interruption. The tag already exists.

3. Deploy using the existing signature/probe/rollback path:

   ```sh
   ssh root@pve incus exec den -- env TUF_ROOT=/var/lib/den/sigstore /usr/local/bin/den-update den-edge
   ssh root@pve incus exec den -- curl -fsS http://127.0.0.1:8094/version
   ssh root@pve incus exec den -- curl -fsS http://127.0.0.1:8094/health
   ```

   `den-update` verifies the image signature, probes a replacement, pins the digest, restarts, checks live health, and rolls back on failure. Do not read or print runtime environment secrets. Expect version `0.50.1` and status `ok`.

4. Verify live HTTP headers/conditional requests on the production origin `https://pve.tailce93d3.ts.net:8443/`: root `no-cache` + ETag + CSP `object-src 'none'`; matching `If-None-Match` gives 304; hashed assets remain immutable and compressed; API responses remain `no-store`. Rust tests already cover these semantics, but live proxy behavior remains to be checked.

5. Remeasure the **already paired** browser page after deployment under the same mobile conditions. Record actual library request count and LCP improvement; the server byte-budget fix could not affect the earlier measurements because the old server was still running. Update `PERFORMANCE_AUDIT.md`, replacing the pending measurement/deployment entries with observed results. Do not invent a performance score or claim physical iPhone verification.

6. Commit/push the final report update and update these handoff notes to say what actually shipped. Send a short final answer linking the report/release and giving the main measured improvements and remaining limits.

## Browser audit context — preserve it

Chrome DevTools MCP is available through dynamically discovered `mcp__chrome_devtools__*` tools. The `web-perf` skill was read and applied (`/Users/cindy/.codex/skills/web-perf/SKILL.md`).

- Page 4 is **paired** to the user's library, device name “Den performance audit”, in the default browser context. Current URL: `https://oskars-macbook-pro.tailce93d3.ts.net:8443/__build/#library`.
- User's normal preview: `https://oskars-macbook-pro.tailce93d3.ts.net:8443/#library`. It remains Vite + HMR on port 5173 behind Tailscale 8443. Do not replace this server globally.
- `/__build/#library` serves the last `npm run build` output on that same secure origin, preserving pairing/local storage and using the existing API proxies. `/` remains the development app. Production-bundle results are not measurements of Rust static-serving headers; inspect those separately on production.
- Page 4 currently has viewport **393×852×3, mobile/touch**, CPU **4× slowdown**, network **Slow 4G**. No trace is running. Start a manual trace (`reload:true, autoStop:false`), wait until the real billboard/shelves appear, then stop. Auto-stop ended too early in initial runs and incorrectly measured only the logo.
- Page 3 is an **unpaired** production page in isolated context `den-performance-audit`; don't compare its fast login-screen LCP with paired Home.
- Page 2 (`http://127.0.0.1:5197/test/router.html`) belongs to another navigation audit context. Leave it alone.
- **Do not clear storage, cookies, or IndexedDB, and do not request a new pairing code.** The supplied code was already used. Never print storage or credentials.
- Network requests can contain TMDB API keys and encrypted addon configuration in paths. Return only aggregate timings/byte counts and sanitized paths. Do not dump private request headers or URLs into the report. For library timing, filter ResourceTiming by `/^\\/lib\\/[^/]+\\/changes$/` and return only start/duration/bytes, not its URL.
- Physical target is **Brave on iPhone 16 Pro**. Chromium touch emulation does not validate WebKit/browser-native gesture behavior.

## Verified results so far

- Full lint: **0 errors, 0 warnings** (Prettier, ESLint, Stylelint, Svelte/TypeScript).
- Rust: **65 tests passed**, plus Clippy and formatting passed in CI.
- Web unit tests: **252 passed** in 35 files.
- Browser: full local **45 passed** before the final failure-case addition; all **9 affected loading/billboard tests** passed after it; corrected actor tests **30/30 repeated runs passed**. The pending release CI runs all **46** together.
- WASM/CSP browser smoke passed: idle preload, early-action single-flight, async WASM, offline calls, retry, and CSP negative control.
- Build passed; gzip round trips verified. The large deferred HLS chunk still emits Vite's size warning. It was confirmed absent from Home startup requests; don't remove subtitle/audio features or split it arbitrarily merely to silence the warning.
- Paired Vite baseline: FCP **5.524 s**, LCP **13.157 s**, CLS **0.362**.
- Vite with frontend fixes/old backend: LCP **13.369 s**, CLS **0.000**.
- Cached production bundles/old backend: FCP **0.864 s**, LCP **7.214 s**, CLS **0.000**. Five sequential library requests remain the bottleneck (body bytes 88442, 88363, 86943, 86921, 17624). The initial cold request for the new bundle measured FCP **1.892 s**.
- Fixed populated mobile Lighthouse: **Accessibility 100**, **Best Practices 100**, SEO **83**. Remaining SEO warning is Vite returning HTML for missing robots.txt. Optional llms.txt has the same development fallback issue. This MCP Lighthouse tool excludes the performance category; use trace/Paint Timing metrics instead.

## Report and implementation locations

- Main report: `web/PERFORMANCE_AUDIT.md` (draft until final live measurements/deployment are filled in).
- Shelf readiness and priority: `web/src/Library.svelte`, `web/src/lib/libraryNaming.ts`.
- Placeholder dimensions/contrast: `web/src/components/BrowseRow.svelte`, `PosterCard.svelte`.
- Early backdrop/high priority/initial reflow/offscreen accessibility: `web/src/components/Billboard.svelte`, `web/src/lib/tmdb.ts`, `library.ts`.
- Pairing-aware WASM preload/preconnects: `web/src/App.svelte`.
- Sync page budget: `src/library.rs` (`json_string_bytes`); existing security, page byte/row caps, encryption, and writes preserved.
- ETag/304/CSP/missing-file caching: `src/web.rs`.
- Development-only built preview: `web/scripts/previewBuild.ts`, `web/vite.config.ts`; documented in web README.
- New delayed/missing metadata browser tests: `web/e2e/library-loading.spec.mjs`; strengthened early backdrop assertions in `billboard-loading.spec.mjs`.
- Central router/snapshot code was not changed in this performance pass. Earlier extensive behavior work and tests remain in place. The actor failure fix only corrects test readiness.

Useful commands from `den-edge/web`: `npm run lint`, `npm test`, `npm run test:e2e`, `node test/sync-policy-browser.mjs`, `npm run build`. Prefer the plain npm commands to reuse approvals. Rust checks are `cargo test --locked`; local cargo-fmt is absent but `/nix/store/l7xlkqk1bz4w75rwf5dh7pn2br04n59l-rustfmt-1.97.1/bin/rustfmt --check src/web.rs src/library.rs` works. CI supplies rustfmt and Clippy normally.
